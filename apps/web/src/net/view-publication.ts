interface ViewRecord {
  slot: string;
  json: string;
  leaseOwnerId: string;
}

/** Compare visible content, excluding the clock sample and publication metadata. */
export function prepareViewPublication(
  proposed: Record<string, unknown>,
  committed: ReadonlyMap<string, string>,
) {
  const updates = { ...proposed };
  const signatures = new Map<string, string>();
  for (const [path, record] of Object.entries(proposed)) {
    if (!path.startsWith('views/')) continue;
    const viewRecord = record as ViewRecord;
    const { serverNowMs: _clock, ...visible } = JSON.parse(viewRecord.json);
    const signature = JSON.stringify([viewRecord.slot, viewRecord.leaseOwnerId, visible]);
    if (committed.get(path) === signature) delete updates[path];
    else signatures.set(path, signature);
  }
  return { updates, signatures };
}
