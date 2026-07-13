// 00_config.js — Configuration constants (Overpass, mile-marker service, DMS proxy, tuning params)
// Part of the NC Traffic app; loaded as a classic (non-module) script so it
// shares top-level `let`/`const` scope with the other js/*.js files.

// ---------- Config ----------
const CAMERAS_URL = './cameras.json';
const MIN_DISPLACEMENT_M = 40;     // min movement before recomputing bearing
const BEARING_DISAGREE_DEG = 45;   // how much new bearing must differ to challenge current direction
const BEARING_CONFIRM_COUNT = 2;   // consecutive disagreeing samples needed to flip direction
const HIGHWAY_RECHECK_MS = 6000;   // re-run highway snap at most this often (base rate — backs off on repeated failures, see overpassFailStreak in 01_state.js)
const HIGHWAY_RECHECK_MAX_MS = 90000; // cap for the exponential backoff below, so we never go longer than 90s between attempts even during a sustained outage/rate-limit
const HIGHWAY_CONFIRM_COUNT = 2;   // consecutive matching reads needed before switching displayed highway
const MAX_SEARCH_DIST_M = 24140.2; // ~15 miles — cameras farther than this on your highway are ignored
const SWAP_BUFFER_M = 402.336;     // 1320 ft (1/4 mile) — a camera stays the displayed
                                    // "nearest"/"next" camera, counting down through negative
                                    // distance, until it's this far behind you
const BROWSE_RANGE_M = 80467;      // ~50 miles — how far the manual ahead/behind scan can look
const MANIFEST_TIMEOUT_MS = 12000; // if a stream hasn't started playing within this long, treat as stalled
const MAX_STREAM_RETRIES = 3;      // automatic retry attempts before showing a manual "tap to retry" button

// ---- Mile marker lookup (NCDOT's real mile marker sign inventory) ----
// Hosted ArcGIS Online feature service — actual sign locations, not
// cartographic hatching. Fields include RouteName, SignMP (the number
// printed on the sign), RouteDirection, Latitude/Longitude.
const MILEMARKER_QUERY_URL = 'https://services.arcgis.com/NuWFvHYDMVmmxMeM/arcgis/rest/services/NCDOT_Mile_Markers_Published_View/FeatureServer/0/query';
const MILEMARKER_SEARCH_RADIUS_M = 900;  // ~0.56mi — wide enough to bracket the two nearest signs
const MILEMARKER_RECHECK_MS = 8000;      // how often we re-query for the current milepost

// ---- Highway shield images (Wikipedia / Wikimedia Commons) ----
// Special:FilePath redirects straight to the file, so it works as a plain
// <img src> with no API key or CORS preflight needed. We try a short list
// of likely filenames per route type and fall back silently if none load.
const COMMONS_FILEPATH = 'https://commons.wikimedia.org/wiki/Special:FilePath/';

// ---- DriveNC message signs (DMS), via a small proxy ----
// DriveNC's API needs a developer key, and GitHub Pages can't keep a key
// secret (it's a static site — anything in the JS is public). So instead
// of calling DriveNC directly, the browser calls a tiny serverless proxy
// that holds the key server-side and forwards the request. See
// messagesigns-worker/ for the ~15-line Cloudflare Worker to deploy (free
// tier, no server to maintain) and messagesigns-worker/README.md for setup.
// Point this at your deployed worker URL once it's live.
const MSG_SIGN_PROXY_URL = 'https://ncdotdms.m-c-hunt429.workers.dev/';
const MSG_SIGN_RANGE_M = 16093.4;   // 10 miles
const MSG_SIGN_POLL_MS = 30000;     // re-poll signs this often so a sign 10mi out
                                     // can't silently change message before we reach it

