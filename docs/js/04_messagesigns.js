// 04_messagesigns.js — NCDOT DMS (message sign) fetching, matching, banner + speech
// Part of the NC Traffic app; loaded as a classic (non-module) script so it
// shares top-level `let`/`const` scope with the other js/*.js files.

// ---------- DMS message signs (via proxy) ----------
async function fetchMessageSignsIfNeeded() {
  const now = Date.now();
  if (now - lastMsgSignFetch < MSG_SIGN_POLL_MS) return;
  lastMsgSignFetch = now;
  if (!MSG_SIGN_PROXY_URL || MSG_SIGN_PROXY_URL.includes('YOUR-WORKER-SUBDOMAIN')) {
    setDebug({ messageSigns: 'MSG_SIGN_PROXY_URL not configured — deploy messagesigns-worker/ and update the constant' });
    return;
  }
  try {
    const resp = await fetch(MSG_SIGN_PROXY_URL);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    messageSigns = await resp.json();
    if (!Array.isArray(messageSigns)) throw new Error('unexpected response shape: ' + JSON.stringify(messageSigns).slice(0, 200));
  } catch (err) {
    setDebug({ messageSigns: `proxy fetch failed: ${err.message}` });
  }
}

// Some DMS entries report DirectionOfTravel as "Unknown" (or omit it
// entirely) even though the sign's own Name encodes it, e.g. "DMS13-I40-60W"
// is westbound. Only used as a fallback — DirectionOfTravel is trusted
// whenever it actually says something. Only Name is checked — other fields
// like Id can also contain "DMS" without actually encoding direction.
//
// Also handles I-485's "Inner"/"Outer" convention: confirmed names end in
// a trailing I or O (e.g. an I-485 sign ending "...66O" for Outer), same
// trailing-letter pattern as N/S/E/W just with different letters. This is
// naturally safe against false matches on other highways' signs even
// though "I"/"O" are common letters: the trailing-letter regex only fires
// as a fallback when DirectionOfTravel doesn't already say something
// useful, and its result is only ever accepted if it equals
// highwayDirectionLabel — which can only BE "Inner"/"Outer" when we're
// actually locked onto I-485 in the first place, and the caller
// separately requires the sign's Roadway to match our currentHighway too.
function directionFromSignId(s) {
  const map = { N: 'Northbound', S: 'Southbound', E: 'Eastbound', W: 'Westbound', I: 'Inner', O: 'Outer' };
  if (typeof s.Name !== 'string') return null;
  const m = /([NSEWIO])\s*[)\]]*\s*$/i.exec(s.Name.trim());
  return m ? map[m[1].toUpperCase()] : null;
}

// Extracted from the old inline dirMatches()/roadway-check so both the
// live "closest sign" pick and manual ahead/behind browsing use the exact
// same eligibility rules — otherwise browsing could show a sign live
// detection would never have picked (or vice versa), which would be a
// confusing inconsistency.
function messageSignDirMatches(s) {
  if (!highwayDirectionLabel) return false; // our own direction isn't known yet — can't confirm
                                              // a directional sign applies to us, so don't show it
  const signDir = s.DirectionOfTravel;
  if (signDir && signDir !== 'None' && signDir !== 'Unknown') {
    if (signDir === 'All Directions' || signDir === 'Both Directions') return true;
    return signDir === highwayDirectionLabel;
  }
  // DirectionOfTravel is missing/None/Unknown — fall back to the sign ID's
  // trailing letter instead of refusing to show the sign at all.
  const inferred = directionFromSignId(s);
  return inferred ? inferred === highwayDirectionLabel : false;
}

function messageSignRoadwayMatches(s) {
  return currentHighway.some(h => (s.Roadway || '').toUpperCase().includes(h.replace('-', ''))
    || (s.Roadway || '').toUpperCase().includes(h));
}

// Direction+roadway-filtered, signed-distance-scored, sorted-nearest-first
// list of active (non-blank) message signs — shared basis for both the
// live "closest" pick and manual browsing. minDist/maxDist let callers use
// a tight window (live: a small negative buffer so a sign doesn't vanish
// the instant you pass it) or the full symmetric range (browsing: can page
// backward the same distance it can page forward), mirroring
// getScoredCameras() in 05_cameras.js.
function getScoredMessageSigns(lat, lon, minDist, maxDist) {
  if (!messageSigns.length || !currentHighway || !currentHighway.length || !highwayDirectionLabel) return [];

  return messageSigns
    .filter(s => s.Messages && s.Messages.length && s.Messages[0] !== 'NO_MESSAGE')
    .filter(messageSignDirMatches)
    .filter(messageSignRoadwayMatches)
    .map(s => {
      const straightDist = haversineMeters(lat, lon, s.Latitude, s.Longitude);
      const bearingToSign = bearingDeg(lat, lon, s.Latitude, s.Longitude);
      const dist = lastStableBearing === null
        ? straightDist
        : straightDist * Math.cos(toRad(angleDiff(bearingToSign, lastStableBearing)));
      return { sign: s, dist };
    })
    .filter(c => c.dist >= minDist && c.dist <= maxDist)
    .sort((a, b) => a.dist - b.dist);
}

function pickActiveMessageSign(lat, lon) {
  if (!messageSigns.length || !currentHighway || !currentHighway.length) return null;

  if (highwayDirectionLabel) {
    const nearbyForDebug = messageSigns
      .filter(s => s.Messages && s.Messages.length && s.Messages[0] !== 'NO_MESSAGE')
      .map(s => ({ s, dist: haversineMeters(lat, lon, s.Latitude, s.Longitude) }))
      .filter(x => x.dist <= MSG_SIGN_RANGE_M)
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 5)
      .map(x => ({
        raw: x.s, // full object — check this if the field name assumptions above are wrong
        Roadway: x.s.Roadway,
        DirectionOfTravel: x.s.DirectionOfTravel,
        inferredDirection: directionFromSignId(x.s),
        dirMatched: messageSignDirMatches(x.s),
        roadwayMatched: messageSignRoadwayMatches(x.s),
        distMi: Math.round(x.dist / 160.934) / 10,
      }));
    if (nearbyForDebug.length) {
      console.log('[DMS debug] our direction:', highwayDirectionLabel, 'currentHighway:', currentHighway, nearbyForDebug);
    }
  }

  const scored = getScoredMessageSigns(lat, lon, -SWAP_BUFFER_M, MSG_SIGN_RANGE_M);
  return scored.length ? scored[0] : null;
}

// ---------- Manual ahead/behind DMS browsing ----------
// Lets you page through message signs further out than the live nearest
// match, without changing what the live auto-detected banner (and its
// one-time speech) shows — mirrors the camera browse pattern in
// 06_browse.js. Snapshots the sign list at the moment you first press a
// button (using your last known position), then Ahead/Behind just walk an
// index through that snapshot. Only ever includes signs with an active
// message (per your call — a page full of "no message" signs would just
// be clutter, not useful information) and stays direction-filtered, same
// eligibility rules as live detection via getScoredMessageSigns() above.
let msgBrowseActive = false;
let msgBrowseList = [];
let msgBrowseIndex = 0;

function enterMsgBrowseIfNeeded() {
  if (msgBrowseActive || !lastKnownPos) return false;
  // Uses BROWSE_RANGE_M (same ~50mi range camera browsing uses) rather
  // than the tighter MSG_SIGN_RANGE_M live-detection radius — browsing
  // should be able to scan as far ahead as camera browsing does; live
  // auto-detection stays at its original tighter range so a random sign
  // 50 miles out doesn't trigger the live banner/speech.
  const list = getScoredMessageSigns(lastKnownPos.lat, lastKnownPos.lon, -BROWSE_RANGE_M, BROWSE_RANGE_M);
  if (!list.length) return false;
  // Start browsing from whichever sign is currently closest to your actual
  // position, so the first tap moves logically forward/back from where
  // you already are rather than jumping to the list's edge.
  let closestIdx = 0, closestAbs = Infinity;
  list.forEach((s, i) => { const a = Math.abs(s.dist); if (a < closestAbs) { closestAbs = a; closestIdx = i; } });
  msgBrowseList = list;
  msgBrowseIndex = closestIdx;
  msgBrowseActive = true;
  return true;
}

function moveMsgAhead() {
  const justEntered = enterMsgBrowseIfNeeded();
  if (!msgBrowseActive) return;
  if (!justEntered) msgBrowseIndex = Math.min(msgBrowseIndex + 1, Math.max(0, msgBrowseList.length - 1));
  updateMessageBanner(lastKnownPos.lat, lastKnownPos.lon);
}

function moveMsgBehind() {
  const justEntered = enterMsgBrowseIfNeeded();
  if (!msgBrowseActive) return;
  if (!justEntered) msgBrowseIndex = Math.max(msgBrowseIndex - 1, 0);
  updateMessageBanner(lastKnownPos.lat, lastKnownPos.lon);
}

function exitMsgBrowse() {
  msgBrowseActive = false;
  msgBrowseList = [];
  msgBrowseIndex = 0;
  if (lastKnownPos) updateMessageBanner(lastKnownPos.lat, lastKnownPos.lon);
}

// Shows/hides the small ◀ Closest ▶ controls row. Kept deliberately
// minimal (mobile real estate) — hidden entirely unless there's at least
// one sign to browse to, so it adds zero footprint on quiet stretches of
// highway. The middle button is a static "Closest" label (not a counter —
// a bare N/M number didn't mean anything at a glance) that returns to live
// tracking, matching the camera scan bar's "Closest Cam" button.
function renderMessageBrowseControls(hasBrowsableSigns) {
  const controls = document.getElementById('msg-scan-controls');
  if (!controls) return; // markup not present — degrade silently rather than throw
  const counter = document.getElementById('msg-scan-counter-btn');
  const behindBtn = document.getElementById('msg-scan-behind-btn');
  const aheadBtn = document.getElementById('msg-scan-ahead-btn');

  if (!hasBrowsableSigns && !msgBrowseActive) {
    controls.style.display = 'none';
    return;
  }
  controls.style.display = '';
  counter.textContent = 'Closest';
  counter.classList.toggle('active', msgBrowseActive);
  if (msgBrowseActive) {
    behindBtn.disabled = msgBrowseIndex <= 0;
    aheadBtn.disabled = msgBrowseIndex >= msgBrowseList.length - 1;
  } else {
    behindBtn.disabled = false; // live mode's arrows always just START browsing from here
    aheadBtn.disabled = false;
  }
}

function speakMessage(text) {
  if (!('speechSynthesis' in window)) return;
  try {
    window.speechSynthesis.cancel(); // don't stack overlapping announcements
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = 0.95;
    window.speechSynthesis.speak(utter);
  } catch (err) {
    console.warn('Speech synthesis failed:', err);
  }
}

async function updateMessageBanner(lat, lon) {
  await fetchMessageSignsIfNeeded();

  // Falls back to writing straight into msgBannerEl if the new
  // #msg-banner-content wrapper hasn't been added to index.html yet —
  // browsing controls just won't appear until that markup's in place, but
  // the existing live-message display keeps working either way.
  const contentEl = document.getElementById('msg-banner-content') || msgBannerEl;

  let active, isLive, hasBrowsableSigns;
  if (msgBrowseActive) {
    active = msgBrowseList[msgBrowseIndex] || null;
    isLive = false;
    hasBrowsableSigns = msgBrowseList.length > 0;
  } else {
    active = pickActiveMessageSign(lat, lon);
    isLive = true;
    // Same wide BROWSE_RANGE_M used to populate browsing, just to decide
    // whether the arrows are worth showing at all right now.
    hasBrowsableSigns = getScoredMessageSigns(lat, lon, -BROWSE_RANGE_M, BROWSE_RANGE_M).length > 0;
  }

  renderMessageBrowseControls(hasBrowsableSigns);

  if (!active) {
    msgBannerEl.style.display = 'none';
    if (isLive) activeSignId = null;
    return;
  }

  const msgText = active.sign.Messages.join(' • ');
  contentEl.innerHTML = '';
  const main = document.createElement('div');
  main.textContent = msgText;
  const meta = document.createElement('span');
  meta.className = 'msg-meta';
  meta.textContent = isLive
    ? `${formatDistance(Math.max(0, active.dist))} ahead`
    : `${formatDistance(Math.abs(active.dist))} ${active.dist >= 0 ? 'ahead' : 'behind'}`;
  contentEl.appendChild(main);
  contentEl.appendChild(meta);
  msgBannerEl.style.display = 'block';

  // Speak only for the live, auto-detected sign — never while manually
  // browsing — and only when it's a genuinely new sign/message, not every poll.
  if (isLive) {
    const signKey = active.sign.Id + '::' + msgText;
    if (signKey !== activeSignId && msgText !== lastSpokenMessage) {
      speakMessage(msgText);
      lastSpokenMessage = msgText;
    }
    activeSignId = signKey;
  }
}
