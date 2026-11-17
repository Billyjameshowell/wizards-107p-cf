/**
 * Ticketmaster event pages. Ids live on each game (`tm_event_id` in the book),
 * not in the components that render the link.
 */

export function ticketmasterEventUrl(eventId: string | null | undefined): string | null {
  const id = eventId?.trim();
  if (!id) return null;
  return `https://www.ticketmaster.com/event/${id}`;
}

/** Fill a missing id from the seed book. An id already on the game stays. */
export function applyTicketmasterIds<T extends { date: string; tm_event_id?: string | null }>(
  games: readonly T[],
  seed: readonly { date: string; tm_event_id?: string | null }[],
): T[] {
  const ids = new Map(seed.map((game) => [game.date, game.tm_event_id?.trim() || null]));
  return games.map((game) => {
    const id = game.tm_event_id?.trim() || ids.get(game.date) || null;
    if (id === (game.tm_event_id ?? null)) return game;
    return { ...game, tm_event_id: id };
  });
}
