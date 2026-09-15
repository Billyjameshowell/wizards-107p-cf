# NBA team logos

These files are local copies of the primary large team marks served by the official NBA CDN. They are referenced by `src/shared/teams.ts` with paths such as `/team-logos/was.svg`, so the ticket book does not depend on a third-party image request at runtime. The UI can render them at 20px or any other small size.

The numeric IDs below are the official NBA team IDs. Each ID is also the ID in the corresponding NBA.com team page and in the CDN URL. The colors in the mapping are display accents only; the logo artwork remains the NBA supplied SVG.

| file | team | NBA team page | logo source |
| --- | --- | --- | --- |
| `atl.svg` | Atlanta Hawks (ATL) | https://www.nba.com/team/1610612737 | https://cdn.nba.com/logos/nba/1610612737/primary/L/logo.svg |
| `bos.svg` | Boston Celtics (BOS) | https://www.nba.com/team/1610612738 | https://cdn.nba.com/logos/nba/1610612738/primary/L/logo.svg |
| `cle.svg` | Cleveland Cavaliers (CLE) | https://www.nba.com/team/1610612739 | https://cdn.nba.com/logos/nba/1610612739/primary/L/logo.svg |
| `nop.svg` | New Orleans Pelicans (NOP) | https://www.nba.com/team/1610612740 | https://cdn.nba.com/logos/nba/1610612740/primary/L/logo.svg |
| `chi.svg` | Chicago Bulls (CHI) | https://www.nba.com/team/1610612741 | https://cdn.nba.com/logos/nba/1610612741/primary/L/logo.svg |
| `dal.svg` | Dallas Mavericks (DAL) | https://www.nba.com/team/1610612742 | https://cdn.nba.com/logos/nba/1610612742/primary/L/logo.svg |
| `den.svg` | Denver Nuggets (DEN) | https://www.nba.com/team/1610612743 | https://cdn.nba.com/logos/nba/1610612743/primary/L/logo.svg |
| `gsw.svg` | Golden State Warriors (GSW) | https://www.nba.com/team/1610612744 | https://cdn.nba.com/logos/nba/1610612744/primary/L/logo.svg |
| `hou.svg` | Houston Rockets (HOU) | https://www.nba.com/team/1610612745 | https://cdn.nba.com/logos/nba/1610612745/primary/L/logo.svg |
| `lac.svg` | LA Clippers (LAC) | https://www.nba.com/team/1610612746 | https://cdn.nba.com/logos/nba/1610612746/primary/L/logo.svg |
| `lal.svg` | Los Angeles Lakers (LAL) | https://www.nba.com/team/1610612747 | https://cdn.nba.com/logos/nba/1610612747/primary/L/logo.svg |
| `mia.svg` | Miami Heat (MIA) | https://www.nba.com/team/1610612748 | https://cdn.nba.com/logos/nba/1610612748/primary/L/logo.svg |
| `mil.svg` | Milwaukee Bucks (MIL) | https://www.nba.com/team/1610612749 | https://cdn.nba.com/logos/nba/1610612749/primary/L/logo.svg |
| `min.svg` | Minnesota Timberwolves (MIN) | https://www.nba.com/team/1610612750 | https://cdn.nba.com/logos/nba/1610612750/primary/L/logo.svg |
| `bkn.svg` | Brooklyn Nets (BKN) | https://www.nba.com/team/1610612751 | https://cdn.nba.com/logos/nba/1610612751/primary/L/logo.svg |
| `nyk.svg` | New York Knicks (NYK) | https://www.nba.com/team/1610612752 | https://cdn.nba.com/logos/nba/1610612752/primary/L/logo.svg |
| `orl.svg` | Orlando Magic (ORL) | https://www.nba.com/team/1610612753 | https://cdn.nba.com/logos/nba/1610612753/primary/L/logo.svg |
| `ind.svg` | Indiana Pacers (IND) | https://www.nba.com/team/1610612754 | https://cdn.nba.com/logos/nba/1610612754/primary/L/logo.svg |
| `phi.svg` | Philadelphia 76ers (PHI) | https://www.nba.com/team/1610612755 | https://cdn.nba.com/logos/nba/1610612755/primary/L/logo.svg |
| `phx.svg` | Phoenix Suns (PHX) | https://www.nba.com/team/1610612756 | https://cdn.nba.com/logos/nba/1610612756/primary/L/logo.svg |
| `por.svg` | Portland Trail Blazers (POR) | https://www.nba.com/team/1610612757 | https://cdn.nba.com/logos/nba/1610612757/primary/L/logo.svg |
| `sac.svg` | Sacramento Kings (SAC) | https://www.nba.com/team/1610612758 | https://cdn.nba.com/logos/nba/1610612758/primary/L/logo.svg |
| `sas.svg` | San Antonio Spurs (SAS) | https://www.nba.com/team/1610612759 | https://cdn.nba.com/logos/nba/1610612759/primary/L/logo.svg |
| `okc.svg` | Oklahoma City Thunder (OKC) | https://www.nba.com/team/1610612760 | https://cdn.nba.com/logos/nba/1610612760/primary/L/logo.svg |
| `tor.svg` | Toronto Raptors (TOR) | https://www.nba.com/team/1610612761 | https://cdn.nba.com/logos/nba/1610612761/primary/L/logo.svg |
| `uta.svg` | Utah Jazz (UTA) | https://www.nba.com/team/1610612762 | https://cdn.nba.com/logos/nba/1610612762/primary/L/logo.svg |
| `mem.svg` | Memphis Grizzlies (MEM) | https://www.nba.com/team/1610612763 | https://cdn.nba.com/logos/nba/1610612763/primary/L/logo.svg |
| `was.svg` | Washington Wizards (WAS) | https://www.nba.com/team/1610612764 | https://cdn.nba.com/logos/nba/1610612764/primary/L/logo.svg |
| `det.svg` | Detroit Pistons (DET) | https://www.nba.com/team/1610612765 | https://cdn.nba.com/logos/nba/1610612765/primary/L/logo.svg |
| `cha.svg` | Charlotte Hornets (CHA) | https://www.nba.com/team/1610612766 | https://cdn.nba.com/logos/nba/1610612766/primary/L/logo.svg |

`unknown.svg` is a local neutral fallback for `TBD`, missing, or future opponent labels. It intentionally carries no NBA team branding.

The downloaded files were checked for scripts, raster `<image>` tags, and remote `href`/URL references. Internal SVG definitions such as `url(#...)` and `xlink:href="#..."` remain part of the official artwork and do not make network requests.
