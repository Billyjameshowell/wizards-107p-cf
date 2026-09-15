export type Team = {
  abbreviation: string;
  name: string;
  logo: string;
  color: string;
  /** NBA's stable team identifier, retained for attribution and future API joins. */
  nbaId: number;
};

export type UnknownTeam = Omit<Team, "nbaId"> & { nbaId: null };

const team = (
  abbreviation: string,
  name: string,
  nbaId: number,
  color: string,
): Team => ({
  abbreviation,
  name,
  nbaId,
  color,
  logo: `/team-logos/${abbreviation.toLowerCase()}.svg`,
});

export const UNKNOWN_TEAM: UnknownTeam = {
  abbreviation: "TBD",
  name: "TBD",
  nbaId: null,
  color: "#64748b",
  logo: "/team-logos/unknown.svg",
};

/**
 * Teams represented in the seed book, plus Washington for the masthead.
 * IDs are the official NBA team IDs used in NBA.com team URLs and the logo CDN.
 */
export const NBA_TEAMS = {
  ATL: team("ATL", "Atlanta Hawks", 1610612737, "#E03A3E"),
  BOS: team("BOS", "Boston Celtics", 1610612738, "#007A33"),
  CLE: team("CLE", "Cleveland Cavaliers", 1610612739, "#860038"),
  NOP: team("NOP", "New Orleans Pelicans", 1610612740, "#0C2340"),
  CHI: team("CHI", "Chicago Bulls", 1610612741, "#CE1141"),
  DAL: team("DAL", "Dallas Mavericks", 1610612742, "#00538C"),
  DEN: team("DEN", "Denver Nuggets", 1610612743, "#0E2240"),
  GSW: team("GSW", "Golden State Warriors", 1610612744, "#1D428A"),
  HOU: team("HOU", "Houston Rockets", 1610612745, "#CE1141"),
  LAC: team("LAC", "LA Clippers", 1610612746, "#C8102E"),
  LAL: team("LAL", "Los Angeles Lakers", 1610612747, "#552583"),
  MIA: team("MIA", "Miami Heat", 1610612748, "#98002E"),
  MIL: team("MIL", "Milwaukee Bucks", 1610612749, "#00471B"),
  MIN: team("MIN", "Minnesota Timberwolves", 1610612750, "#0C2340"),
  BKN: team("BKN", "Brooklyn Nets", 1610612751, "#000000"),
  NYK: team("NYK", "New York Knicks", 1610612752, "#006BB6"),
  ORL: team("ORL", "Orlando Magic", 1610612753, "#0077C0"),
  IND: team("IND", "Indiana Pacers", 1610612754, "#002D62"),
  PHI: team("PHI", "Philadelphia 76ers", 1610612755, "#006BB6"),
  PHX: team("PHX", "Phoenix Suns", 1610612756, "#E56020"),
  POR: team("POR", "Portland Trail Blazers", 1610612757, "#E03A3E"),
  SAC: team("SAC", "Sacramento Kings", 1610612758, "#5A2D81"),
  SAS: team("SAS", "San Antonio Spurs", 1610612759, "#C4CED4"),
  OKC: team("OKC", "Oklahoma City Thunder", 1610612760, "#007AC1"),
  TOR: team("TOR", "Toronto Raptors", 1610612761, "#CE1141"),
  UTA: team("UTA", "Utah Jazz", 1610612762, "#002B5C"),
  MEM: team("MEM", "Memphis Grizzlies", 1610612763, "#5D76A9"),
  WAS: team("WAS", "Washington Wizards", 1610612764, "#002B5C"),
  DET: team("DET", "Detroit Pistons", 1610612765, "#C8102E"),
  CHA: team("CHA", "Charlotte Hornets", 1610612766, "#1D1160"),
} as const satisfies Record<string, Team>;

const normalize = (value: string): string => value.trim().toLowerCase().replace(/[^a-z0-9]/g, "");

const aliases: Record<string, keyof typeof NBA_TEAMS> = {
  atl: "ATL",
  atlantahawks: "ATL",
  bos: "BOS",
  bostonceltics: "BOS",
  cle: "CLE",
  clevelandcavaliers: "CLE",
  nop: "NOP",
  neworleanspelicans: "NOP",
  chi: "CHI",
  chicagobulls: "CHI",
  dal: "DAL",
  dallas: "DAL",
  dallasmavericks: "DAL",
  den: "DEN",
  denvernuggets: "DEN",
  gsw: "GSW",
  goldenstatewarriors: "GSW",
  hou: "HOU",
  houstonrockets: "HOU",
  lac: "LAC",
  laclippers: "LAC",
  losangelesclippers: "LAC",
  lal: "LAL",
  lalakers: "LAL",
  lalosangeleslakers: "LAL",
  losangeleslakers: "LAL",
  mia: "MIA",
  miamiheat: "MIA",
  mil: "MIL",
  milwaukeebucks: "MIL",
  min: "MIN",
  minnesotatimberwolves: "MIN",
  bkn: "BKN",
  brooklynnets: "BKN",
  nyk: "NYK",
  newyorkknicks: "NYK",
  orl: "ORL",
  orlandomagic: "ORL",
  ind: "IND",
  indianapacers: "IND",
  phi: "PHI",
  philadelphia76ers: "PHI",
  sixers: "PHI",
  phx: "PHX",
  phoenixsuns: "PHX",
  por: "POR",
  portlandtrailblazers: "POR",
  sac: "SAC",
  sacramentokings: "SAC",
  sas: "SAS",
  sanantoniospurs: "SAS",
  okc: "OKC",
  oklahomacitythunder: "OKC",
  tor: "TOR",
  torontoraptors: "TOR",
  uta: "UTA",
  utahjazz: "UTA",
  mem: "MEM",
  memphisgrizzlies: "MEM",
  was: "WAS",
  washington: "WAS",
  washingtonwizards: "WAS",
  det: "DET",
  detroitpistons: "DET",
  cha: "CHA",
  charlottehornets: "CHA",
};

/** Resolve a schedule opponent while keeping unknown/TBD rows displayable. */
export function teamForOpponent(opponent: string | null | undefined): Team | UnknownTeam {
  const label = opponent?.trim() || UNKNOWN_TEAM.name;
  const key = aliases[normalize(label)];
  return key ? NBA_TEAMS[key] : { ...UNKNOWN_TEAM, name: label };
}
