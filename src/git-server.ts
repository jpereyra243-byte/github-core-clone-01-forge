import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GitObject } from './git.ts';
import {
  ZERO_OID,
  encodePktLine,
  pktLineFlush,
  pktLineDelim,
  decodePktLines,
  encodeSideband,
  readPack,
  writePack,
  parseCommit,
  parseTag,
  PktLineDecoder,
} from './git.ts';
import { ForgeStore } from './store.ts';
import type { Repository } from './store.ts';

export class GitHttpHandler {
  private store: ForgeStore;
  constructor(store: ForgeStore) {
    this.store = store;
  }

  // Parse path: /{owner}/{repo}.git/{serviceOrSubpath}
  match(path: string): { owner: string; repo: string; action: string } | null {
    const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
    if (!match) return null;
    return { owner: match[1], repo: match[2], action: match[3] };
  }

  async handle(req: IncomingMessage, res: ServerResponse, owner: string, repoName: string, action: string): Promise<void> {
    const repo = this.store.getRepo(owner, repoName);
    if (!repo) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Repository not found\n');
      return;
    }

    if (action === 'info/refs') {
      const url = new URL(req.url ?? '/', 'http://entry');
      const service = url.searchParams.get('service');
      if (service === 'git-upload-pack') {
        this.handleUploadPackAdvertisement(req, res, repo);
        return;
      }
      if (service === 'git-receive-pack') {
        this.handleReceivePackAdvertisement(req, res, repo);
        return;
      }
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Unsupported service\n');
      return;
    }

    if (req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      }
      const body = Buffer.concat(chunks);

      if (action === 'git-upload-pack') {
        this.handleUploadPackPost(req, res, repo, body);
        return;
      }
      if (action === 'git-receive-pack') {
        this.handleReceivePackPost(req, res, repo, body);
        return;
      }
    }

    res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Method not allowed\n');
  }

  private handleUploadPackAdvertisement(req: IncomingMessage, res: ServerResponse, repo: Repository): void {
    const gitProtocol = req.headers['git-protocol'] as string | undefined;
    const isV2 = gitProtocol && gitProtocol.split(':').some((part) => part.trim() === 'version=2');

    res.writeHead(200, {
      'content-type': 'application/x-git-upload-pack-advertisement',
      'cache-control': 'no-cache',
    });

    if (isV2) {
      // Protocol v2 advertisement
      const lines: Buffer[] = [
        encodePktLine('version 2\n'),
        encodePktLine('ls-refs=peel symrefs unborn\n'),
        encodePktLine('fetch=shallow wait-for-done filter\n'),
        encodePktLine('object-format=sha1\n'),
        encodePktLine('agent=makefun-forge/1.0\n'),
        pktLineFlush(),
      ];
      res.end(Buffer.concat(lines));
      return;
    }

    // Protocol v0 advertisement
    const parts: Buffer[] = [
      encodePktLine('# service=git-upload-pack\n'),
      pktLineFlush(),
    ];

    const caps = 'multi_ack_detailed thin-pack side-band side-band-64k ofs-delta agent=makefun-forge/1.0';
    if (repo.refs.size === 0) {
      parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    } else {
      const headOid = repo.refs.get(repo.headSymref) ?? [...repo.refs.values()][0];
      const symrefCap = repo.headSymref ? ` symref=HEAD:${repo.headSymref}` : '';
      let isFirst = true;

      if (headOid) {
        parts.push(encodePktLine(`${headOid} HEAD\0${caps}${symrefCap}\n`));
        isFirst = false;
      }

      for (const [refName, oid] of repo.refs) {
        if (isFirst) {
          parts.push(encodePktLine(`${oid} ${refName}\0${caps}\n`));
          isFirst = false;
        } else {
          parts.push(encodePktLine(`${oid} ${refName}\n`));
        }
        // Peeled tag if tag
        const obj = repo.objects.get(oid);
        if (obj && obj.type === 'tag') {
          const parsed = parseTag(obj.data);
          if (parsed.object) {
            parts.push(encodePktLine(`${parsed.object} ${refName}^{}\n`));
          }
        }
      }
    }
    parts.push(pktLineFlush());
    res.end(Buffer.concat(parts));
  }

  private handleReceivePackAdvertisement(req: IncomingMessage, res: ServerResponse, repo: Repository): void {
    res.writeHead(200, {
      'content-type': 'application/x-git-receive-pack-advertisement',
      'cache-control': 'no-cache',
    });

    const parts: Buffer[] = [
      encodePktLine('# service=git-receive-pack\n'),
      pktLineFlush(),
    ];

    const caps = 'report-status side-band-64k delete-refs ofs-delta agent=makefun-forge/1.0';
    if (repo.refs.size === 0) {
      parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    } else {
      let isFirst = true;
      for (const [refName, oid] of repo.refs) {
        if (isFirst) {
          parts.push(encodePktLine(`${oid} ${refName}\0${caps}\n`));
          isFirst = false;
        } else {
          parts.push(encodePktLine(`${oid} ${refName}\n`));
        }
      }
    }
    parts.push(pktLineFlush());
    res.end(Buffer.concat(parts));
  }

  private handleUploadPackPost(req: IncomingMessage, res: ServerResponse, repo: Repository, body: Buffer): void {
    // Parse pkt-lines
    let packets: ReturnType<typeof decodePktLines>;
    try {
      packets = decodePktLines(body);
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Malformed pkt-line request\n');
      return;
    }

    if (packets.length === 0) {
      res.writeHead(200, {
        'content-type': 'application/x-git-upload-pack-result',
        'cache-control': 'no-cache',
      });
      res.end();
      return;
    }

    res.writeHead(200, {
      'content-type': 'application/x-git-upload-pack-result',
      'cache-control': 'no-cache',
    });

    const firstPacket = packets.find((p) => p.kind === 'data');
    const firstText = firstPacket && firstPacket.kind === 'data' ? firstPacket.payload.toString('utf8').trim() : '';

    if (firstText.startsWith('command=ls-refs')) {
      this.handleV2LsRefs(packets, res, repo);
      return;
    }

    if (firstText.startsWith('command=fetch')) {
      this.handleV2Fetch(packets, res, repo);
      return;
    }

    // Protocol v0 upload-pack fallback
    this.handleV0UploadPack(packets, res, repo);
  }

  private handleV2LsRefs(packets: ReturnType<typeof decodePktLines>, res: ServerResponse, repo: Repository): void {
    const lines = packets.filter((p) => p.kind === 'data').map((p) => (p as { payload: Buffer }).payload.toString('utf8').trim());
    let peel = false;
    let symrefs = false;
    const prefixes: string[] = [];

    for (const line of lines) {
      if (line === 'peel') peel = true;
      if (line === 'symrefs') symrefs = true;
      if (line.startsWith('ref-prefix ')) {
        prefixes.push(line.slice(11).trim());
      }
    }

    const matchesPrefix = (name: string): boolean => {
      if (prefixes.length === 0) return true;
      return prefixes.some((pref) => name.startsWith(pref));
    };

    const out: Buffer[] = [];

    // HEAD
    if (matchesPrefix('HEAD')) {
      const headOid = repo.refs.get(repo.headSymref) ?? (repo.refs.size > 0 ? [...repo.refs.values()][0] : null);
      if (headOid) {
        let line = `${headOid} HEAD`;
        if (symrefs && repo.headSymref) {
          line += ` symref-target:${repo.headSymref}`;
        }
        out.push(encodePktLine(`${line}\n`));
      } else if (repo.refs.size === 0 && symrefs && repo.headSymref) {
        out.push(encodePktLine(`unborn HEAD symref-target:${repo.headSymref}\n`));
      }
    }

    for (const [refName, oid] of repo.refs) {
      if (!matchesPrefix(refName)) continue;
      let line = `${oid} ${refName}`;
      if (peel) {
        const obj = repo.objects.get(oid);
        if (obj && obj.type === 'tag') {
          const parsed = parseTag(obj.data);
          if (parsed.object) {
            line += ` peeled:${parsed.object}`;
          }
        }
      }
      out.push(encodePktLine(`${line}\n`));
    }

    out.push(pktLineFlush());
    res.end(Buffer.concat(out));
  }

  private handleV2Fetch(packets: ReturnType<typeof decodePktLines>, res: ServerResponse, repo: Repository): void {
    const lines = packets.filter((p) => p.kind === 'data').map((p) => (p as { payload: Buffer }).payload.toString('utf8').trim());
    const wants: string[] = [];
    const haves: string[] = [];
    let depth = 0;
    const clientShallows: string[] = [];

    for (const line of lines) {
      if (line.startsWith('want ')) {
        wants.push(line.slice(5).trim());
      } else if (line.startsWith('have ')) {
        haves.push(line.slice(5).trim());
      } else if (line.startsWith('deepen ')) {
        depth = parseInt(line.slice(7).trim(), 10) || 0;
      } else if (line.startsWith('shallow ')) {
        clientShallows.push(line.slice(8).trim());
      }
    }

    // Determine objects to send
    const outPackets: Buffer[] = [];
    outPackets.push(encodePktLine('acknowledgments\n'));
    for (const have of haves) {
      if (repo.objects.has(have)) {
        outPackets.push(encodePktLine(`ACK ${have}\n`));
      }
    }
    if (haves.length === 0 || !haves.some((h) => repo.objects.has(h))) {
      outPackets.push(encodePktLine('NAK\n'));
    }
    outPackets.push(pktLineDelim());

    // Shallow calculation if depth is requested
    const shallowOids: string[] = [];
    const unshallowOids: string[] = [];
    const objectsToSend = new Map<string, GitObject>();

    if (depth > 0) {
      // Traverse commits up to depth
      for (const want of wants) {
        const queue: Array<{ oid: string; d: number }> = [{ oid: want, d: 1 }];
        const visited = new Set<string>();
        while (queue.length > 0) {
          const { oid, d } = queue.shift()!;
          if (visited.has(oid)) continue;
          visited.add(oid);
          const obj = repo.objects.get(oid);
          if (!obj || obj.type !== 'commit') continue;
          objectsToSend.set(oid, obj);
          const commit = parseCommit(obj.data);
          // Include tree and sub-objects of commit
          for (const reachableOid of this.store.collectReachable(repo, [commit.tree], true)) {
            const rObj = repo.objects.get(reachableOid);
            if (rObj) objectsToSend.set(reachableOid, rObj);
          }

          if (d === depth) {
            // Cut boundary
            shallowOids.push(oid);
          } else {
            for (const p of commit.parents) {
              queue.push({ oid: p, d: d + 1 });
            }
          }
        }
      }

      // Check if any client shallow is now unshallowed
      for (const cs of clientShallows) {
        if (!shallowOids.includes(cs) && objectsToSend.has(cs)) {
          unshallowOids.push(cs);
        }
      }

      outPackets.push(encodePktLine('shallow-info\n'));
      for (const s of shallowOids) {
        outPackets.push(encodePktLine(`shallow ${s}\n`));
      }
      for (const u of unshallowOids) {
        outPackets.push(encodePktLine(`unshallow ${u}\n`));
      }
      outPackets.push(pktLineDelim());
    } else {
      // Full reachability walk: objects reachable from wants minus objects reachable from haves
      const haveReachable = this.store.collectReachable(repo, haves, true);
      const wantReachable = this.store.collectReachable(repo, wants, true);

      for (const oid of wantReachable) {
        if (!haveReachable.has(oid)) {
          const obj = repo.objects.get(oid);
          if (obj) objectsToSend.set(oid, obj);
        }
      }
    }

    outPackets.push(encodePktLine('packfile\n'));
    const packBuffer = writePack(objectsToSend.values());
    const sidebandPack = encodeSideband(1, packBuffer);
    outPackets.push(sidebandPack);
    outPackets.push(pktLineFlush());

    res.end(Buffer.concat(outPackets));
  }

  private handleV0UploadPack(packets: ReturnType<typeof decodePktLines>, res: ServerResponse, repo: Repository): void {
    const lines = packets.filter((p) => p.kind === 'data').map((p) => (p as { payload: Buffer }).payload.toString('utf8').trim());
    const wants: string[] = [];
    const haves: string[] = [];

    for (const line of lines) {
      if (line.startsWith('want ')) {
        const parts = line.slice(5).split(' ');
        wants.push(parts[0]);
      } else if (line.startsWith('have ')) {
        haves.push(line.slice(5).trim());
      }
    }

    const out: Buffer[] = [];
    out.push(encodePktLine('NAK\n'));

    const haveReachable = this.store.collectReachable(repo, haves, true);
    const wantReachable = this.store.collectReachable(repo, wants, true);
    const objectsToSend = new Map<string, GitObject>();

    for (const oid of wantReachable) {
      if (!haveReachable.has(oid)) {
        const obj = repo.objects.get(oid);
        if (obj) objectsToSend.set(oid, obj);
      }
    }

    const packBuffer = writePack(objectsToSend.values());
    out.push(encodeSideband(1, packBuffer));
    out.push(pktLineFlush());
    res.end(Buffer.concat(out));
  }

  private handleReceivePackPost(req: IncomingMessage, res: ServerResponse, repo: Repository, body: Buffer): void {
    res.writeHead(200, {
      'content-type': 'application/x-git-receive-pack-result',
      'cache-control': 'no-cache',
    });

    // The body consists of pkt-lines with commands followed by PACK data
    const decoder = new PktLineDecoder(body);
    const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
    let isPackStarting = false;
    let packOffset = 0;

    while (true) {
      const p = decoder.next();
      if (!p) break;
      if (p.kind === 'flush') {
        // After flush, pack data begins
        isPackStarting = true;
        break;
      }
      if (p.kind === 'data') {
        const text = p.payload.toString('utf8');
        const nulIndex = text.indexOf('\0');
        const clean = (nulIndex >= 0 ? text.slice(0, nulIndex) : text).trim();
        const parts = clean.split(' ');
        if (parts.length >= 3) {
          commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
        }
      }
    }

    const rawRemaining = decoder.takeBuffered();
    // Parse pack if remaining bytes start with PACK
    let unpackOk = true;
    let unpackDetail = 'unpack ok';

    if (rawRemaining.length >= 12 && rawRemaining.subarray(0, 4).toString('ascii') === 'PACK') {
      try {
        const { objects } = readPack(rawRemaining, (oid) => repo.objects.get(oid));
        for (const [oid, obj] of objects) {
          repo.objects.set(oid, obj);
        }
      } catch (err) {
        unpackOk = false;
        unpackDetail = (err as Error).message;
      }
    }

    // Evaluate each command
    const refReports: Array<{ ref: string; ok: boolean; reason?: string }> = [];

    if (!unpackOk) {
      for (const cmd of commands) {
        refReports.push({ ref: cmd.ref, ok: false, reason: 'unpack-failed' });
      }
    } else {
      for (const cmd of commands) {
        const currentOid = repo.refs.get(cmd.ref) ?? ZERO_OID;
        if (cmd.oldOid !== ZERO_OID && currentOid !== cmd.oldOid) {
          refReports.push({ ref: cmd.ref, ok: false, reason: 'stale-info' });
          continue;
        }

        if (cmd.newOid === ZERO_OID) {
          // Deletion
          repo.refs.delete(cmd.ref);
          refReports.push({ ref: cmd.ref, ok: true });
          continue;
        }

        if (cmd.oldOid === ZERO_OID) {
          // Creation
          repo.refs.set(cmd.ref, cmd.newOid);
          refReports.push({ ref: cmd.ref, ok: true });
          continue;
        }

        // Fast-forward check: is oldOid an ancestor of newOid?
        if (this.store.isAncestor(repo, cmd.oldOid, cmd.newOid)) {
          repo.refs.set(cmd.ref, cmd.newOid);
          refReports.push({ ref: cmd.ref, ok: true });
        } else {
          refReports.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
        }
      }
    }

    // Format report-status in sideband 1
    const reportLines: Buffer[] = [];
    reportLines.push(encodePktLine(unpackOk ? 'unpack ok\n' : `unpack ${unpackDetail}\n`));
    for (const rep of refReports) {
      if (rep.ok) {
        reportLines.push(encodePktLine(`ok ${rep.ref}\n`));
      } else {
        reportLines.push(encodePktLine(`ng ${rep.ref} ${rep.reason ?? 'failed'}\n`));
      }
    }
    reportLines.push(pktLineFlush());

    const reportBuf = Buffer.concat(reportLines);
    const sidebandReport = encodeSideband(1, reportBuf);
    res.end(Buffer.concat([sidebandReport, pktLineFlush()]));
  }
}
