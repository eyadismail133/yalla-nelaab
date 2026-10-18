import type { RoomView } from '@game/shared';

export interface ProjectionRecord {
  json: string;
  version: number;
  updatedAtMs: number;
  leaseOwnerId: string;
  slot?: string;
}

// Only prompt/progress fields are eligible. Personal answers stay private even when equal.
const PUBLIC_ROUND_FIELDS = new Set([
  'textAr', 'options', 'unitAr', 'stage', 'totalPlayers', 'lockedCount', 'progress',
  'letter', 'fieldsAr', 'readyCount', 'totalItems', 'totalPairs', 'totalQuestions',
  'maxBid', 'pointsPerBid', 'ladder', 'totalHints', 'solvedCount', 'doneCount',
]);

export function splitViewUpdates(proposed: Record<string, unknown>): Record<string, unknown> {
  const updates = { ...proposed };
  const views = Object.entries(proposed).filter(([path]) => path.startsWith('views/')).map(([path, record]) => ({
    uid: path.slice('views/'.length), record: record as ProjectionRecord,
    view: JSON.parse((record as ProjectionRecord).json) as RoomView,
  }));
  if (views.length === 0) return updates;
  const first = views[0]!;
  const commonRound: Record<string, unknown> = {};
  if (first.view.round?.view) {
    for (const [key, field] of Object.entries(first.view.round.view as object)) {
      if (PUBLIC_ROUND_FIELDS.has(key) && views.every(({ view }) =>
        JSON.stringify((view.round?.view as Record<string, unknown>)?.[key]) === JSON.stringify(field))) {
        commonRound[key] = field;
      }
    }
  }
  const { you: _you, ...publicView } = first.view;
  publicView.round = publicView.round ? { ...publicView.round, view: publicView.round.view === null ? null : commonRound } : null;
  const { slot: _slot, ...sharedRecord } = first.record;
  updates.publicView = { ...sharedRecord, json: JSON.stringify(publicView) };
  for (const { uid, record, view } of views) {
    const roundView = view.round?.view === null || !view.round ? null : Object.fromEntries(
      Object.entries(view.round.view as object).filter(([key]) => !(key in commonRound)),
    );
    updates[`privateViews/${uid}`] = { ...record, json: JSON.stringify({ you: view.you, roundView }) };
    delete updates[`views/${uid}`];
  }
  return updates;
}

export function mergeSplitView(shared: ProjectionRecord | null, personal: ProjectionRecord | null): RoomView | null {
  if (!shared || !personal || shared.version !== personal.version || shared.leaseOwnerId !== personal.leaseOwnerId) return null;
  const publicView = JSON.parse(shared.json) as Omit<RoomView, 'you'>;
  const privateView = JSON.parse(personal.json) as { you: RoomView['you']; roundView: Record<string, unknown> | null };
  return {
    ...publicView,
    you: privateView.you,
    round: publicView.round ? {
      ...publicView.round,
      view: publicView.round.view === null ? null : { ...publicView.round.view as object, ...privateView.roundView },
    } : null,
  };
}
