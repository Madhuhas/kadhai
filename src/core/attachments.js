/**
 * A file attached to a request (the dashboard's chat, the CLI's -a): saved under attachments/,
 * never over an existing file - the name gets -2, -3 ... instead. One place for both shells.
 */

export const ATTACH_DIR = 'attachments';
export const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024; // as base64 this still fits the 4 MB JSON limit

const fail = (message, status) => Object.assign(new Error(message), { status });

/** -> { path, bytes } (and whatever writeFile reports) */
export async function saveAttachment(workspace, name, bytes, { owner = 'user' } = {}) {
  const safe = String(name ?? '').replace(/[^\w.\- ]+/g, '_').replace(/^[. ]+/, '').slice(-80).trim();
  if (!safe || !Buffer.isBuffer(bytes)) throw fail('An attachment needs a name and its contents', 400);
  if (!bytes.length) throw fail(`"${safe}" is empty`, 400);
  if (bytes.length > MAX_ATTACHMENT_BYTES) throw fail(`"${safe}" is larger than 2 MB`, 413);
  const dot = safe.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [safe.slice(0, dot), safe.slice(dot)] : [safe, ''];
  let rel = `${ATTACH_DIR}/${safe}`;
  for (let n = 2; await workspace.exists(rel); n++) rel = `${ATTACH_DIR}/${stem}-${n}${ext}`;
  return { ...(await workspace.writeFile(rel, bytes, { owner, timeoutMs: 1500 })), bytes: bytes.length };
}
