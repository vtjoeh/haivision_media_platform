/*
Haivision HMP IPTV - STB Control Macro  v0.3

Purpose: Cisco RoomOS macro to control a Haivision Play 2000/4000 Set-Top Box
through the Haivision Media Platform (HMP) REST API from a Cisco video device.

Modelled on the z-band-iptv macro by Joe Hughes (github.com/vtjoeh/z-band-iptv)
License: MIT
─────────────────────────────────────────────────────────────────────────────
*/

import xapi from 'xapi';

/*
─────────────────────────────────────────────────────────────────────────────
CONFIGURATION
The values below can be overridden per-device via
xConfiguration SystemUnit CustomDeviceId (255 char limit). Example value:

  hmp_host="https://hmp.example.com"; hmp_stb="ae7dcb56-9a62-402d-99e8-e053c4af0ff5"; hmp_user="svc_iptv"; hmp_pass="secret"; hmp_fav="CNN,ESPN,BBC World"

Storing only what differs per room (e.g. just hmp_stb) is recommended.
─────────────────────────────────────────────────────────────────────────────
*/

// "True" or "False" as TEXT. Recommended "False" with a valid HMP certificate.
const ALLOW_INSECURE_HTTPS = 'True';

let hmp_host = 'http://192.168.1.116:8443';   // hmp_host IP address no trailing slash, no port number
let hmp_stb = 'bvgR95DKAXUTr402cyM8ew';       // _id from GET /apis/devices/stbs
let hmp_user = 'haiadmin'; // update user 
let hmp_pass = 'haiadmin'; // update password
let hmp_fav = 'Channel 04,ESPN,BBC World';        // comma-separated favorite source names (max 10)

// Auth mode: 'login' (username/password -> session cookie) or 'cookie' 
const AUTH_MODE = 'login';
let hmp_cookie = '';                       // paste calypso-session-id for 'cookie' mode used in testing

// Volume control:
//   'hmp'   -> HMP set-volume on the STB (absolute, one step per press)
//   'codec' -> the Cisco video device's own volume (smooth press-and-hold)
// Use 'codec' when STB audio is played through the room via an HDMI input.
const VOLUME_CONTROL = 'hmp';
const VOLUME_STEP = 0.10;                 // HMP step (0.00-1.00) per press in 'hmp' mode
const CODEC_VOL_REPEAT_MS = 140;             // repeat interval for 'codec' press-and-hold

const TIMEOUT_HTTP = 4;                      // seconds per API call
const LOGIN_RETRY = 30;                     // seconds to wait before retrying a failed login
const MAX_CHANNELS = 200;                    // safety cap on channels rendered
const TURN_ON_HTTP_CLIENT = true;            // auto-enable HttpClient mode on startup
const RANDOM_START_RANGE = 1;              // seconds; staggers fleet logins so HMP isn't flooded.
const HDMI_INPUT = 2; // HDMI input the Haivision is connected to

const PANEL_LOCATION = 'ControlPanel';  // 'ControlPanel', 'HomeScreen', 'CallControls', 'HomeScreenAndCallControls' - use 'ControlPanel' for MTR devices

/*
─────────────────────────────────────────────────────────────────────────────
Leave the below as-is
─────────────────────────────────────────────────────────────────────────────
*/
const PANEL_ID = 'panel_hmp_iptv';
const PAGE_TV_ID = 'pageid_hmp_tv';
const PAGE_CHANNELS_ID = 'pageid_hmp_channels';
const PAGE_ABOUT_ID = 'pageid_hmp_about';
const PANEL_VERSION = '1.11';
const PANEL_NAME = 'Haivision TV';
const PANEL_ICON = 'Tv';
const PANEL_COLOR = '#005F9E';
const PANEL_ORDER = 1;
const FEEDBACK_ID_FILTER = 'feedback_hmp_filter';
const PAGEID_PREFIX = 'pageid_hmp'; 

let sessionCookie = AUTH_MODE === 'cookie' ? hmp_cookie : '';
let allChannels = [];   // [{ id, name, type }]
let displayedChannels = [];   // the list the channel buttons currently map to
let favoriteChannels = [];   // resolved from hmp_fav names
let currentVolume = 0.5;
let isMuted = false;
let isStandby = false;
let stbInfo = { name: 'unknown', ip: 'unknown', model: 'unknown' };
let timerVolume;
let timerLoginRetry;

let currentPageNumber = 1; /* used for testin of paging */ 

/* ── Startup (randomised delay to stagger fleet logins) ─────────────────── */
const delayMs = Math.random() * RANDOM_START_RANGE * 1000;

console.log(`HMP macro starting in ${(delayMs / 1000).toFixed(1)}s`);

setTimeout(() => {
  turnOnHttpClient();
  buildPanel(allChannels);   // render an empty shell immediately so the panel exists
  updateStatusPage('Starting macro…');
  login();
}, delayMs);

/*
─────────────────────────────────────────────────────────────────────────────
CustomDeviceId overrides
─────────────────────────────────────────────────────────────────────────────
*/
async function loadCustomDeviceId() {
  let strConfig = '';
  try {
    strConfig = await xapi.Config.SystemUnit.CustomDeviceId.get();
  } catch (e) {
    return;
  }
  hmp_host = pick('hmp_host', hmp_host);
  hmp_stb = pick('hmp_stb', hmp_stb);
  hmp_user = pick('hmp_user', hmp_user);
  hmp_pass = pick('hmp_pass', hmp_pass);
  hmp_fav = pick('hmp_fav', hmp_fav);
  hmp_cookie = pick('hmp_cookie', hmp_cookie);

  function pick(key, current) {
    const m = new RegExp(`${key}\\s*=\\s*"([^"]+)"`, 'g').exec(strConfig);
    if (m) { console.info(`Override ${key}="${m[1]}"`); return m[1]; }
    return current;
  }
}

/*
─────────────────────────────────────────────────────────────────────────────
HTTP helpers (parameter casing matches the proven z-band working pattern)
─────────────────────────────────────────────────────────────────────────────
*/
function authHeaders() {
  const h = ['Content-Type: application/json'];
  if (sessionCookie) h.push(`Cookie: calypso-session-id=${sessionCookie}`);
  return h;
}

function httpGet(path) {
  console.log('attempting httpGet', path); 
  return xapi.Command.HttpClient.Get({
    AllowInsecureHttps: ALLOW_INSECURE_HTTPS,
    ResultBody: 'PlainText',
    URL: hmp_host + path,
    Header: authHeaders(),
    Timeout: TIMEOUT_HTTP,
  }).then(res => {
    if (String(res.StatusCode) === '401') throw new Error('401');
    console.log('httpGet', path, JSON.parse(res.Body)); 
    return JSON.parse(res.Body);
  });
}

function httpPost(path, bodyObj) {
  return xapi.Command.HttpClient.Post({
    AllowInsecureHttps: ALLOW_INSECURE_HTTPS,
    ResultBody: 'PlainText',
    URL: hmp_host + path,
    Header: authHeaders(),
    Timeout: TIMEOUT_HTTP,
  }, JSON.stringify(bodyObj)).then(res => {
    if (String(res.StatusCode) === '401') throw new Error('401');
    return res.Body ? JSON.parse(res.Body) : {};
  });
}

// Re-login once on a 401, then retry the call
function withAuth(fn) {
  return fn().catch(err => {
    if (err.message && err.message.includes('401')) {
      console.log('HMP: session expired, re-authenticating');
      return doLogin().then(ok => { if (ok) return fn(); throw err; });
    }
    throw err;
  });
}

/*
─────────────────────────────────────────────────────────────────────────────
Authentication
─────────────────────────────────────────────────────────────────────────────
*/
async function login() {
  await loadCustomDeviceId();
  if (AUTH_MODE === 'cookie') {
    sessionCookie = hmp_cookie;
    updateStatusPage('Using preset session cookie');
    return afterLogin();
  }
  const ok = await doLogin();
  if (ok) return afterLogin();
}

function doLogin() {
  updateStatusPage('Logging in…');
  return xapi.Command.HttpClient.Post({
    AllowInsecureHttps: ALLOW_INSECURE_HTTPS,
    ResultBody: 'PlainText',
    URL: hmp_host + '/apis/authentication/login',
    Header: ['Content-Type: application/json'],
    Timeout: TIMEOUT_HTTP,
  },
    JSON.stringify({ username: hmp_user, password: hmp_pass }))
    .then(res => {
      // Session id may be in the body (data.sessionId) or a Set-Cookie header
      let body = {};
      const calypsoRegex = /calypso-session-id=([^;,\s]+)/i; 
      try { body = JSON.parse(res.Body || '{}'); } catch (e) { 
        console.log(e, 'error reading JSON while attempting logon')
      }
      console.log('login body:', body);
      
      if (body.data && body.data.sessionId) {
        sessionCookie = body.data.sessionId;
        console.log('sessionCookie:', sessionCookie);
      } 
      
      if(!sessionCookie) {
        console.log('header string', JSON.stringify(res.Headers)); 
        const m = (JSON.stringify(res.Headers) || '').match(calypsoRegex);
        if (m) {
          sessionCookie = m[1]; 
          console.log('sessionCookie created from header string. sessionCookie: ', sessionCookie);
        };
      }

      if(!sessionCookie){
        /* iterate through the headers and look for "Value":"calypso-session-id...."  */
        const headers = res.Headers || '';

        for(const header of headers) {
          console.log('HEADER:', header);
          if ("Value" in header) {
            const match1 = header.Value.match(calypsoRegex);
            if (match1) {
              sessionCookie = match1[1];
              console.log('HMP: authenticated via Set-Cookie header match1: ' + sessionCookie);
            }
          }
        }
      }

      if (sessionCookie) {
        updateStatusPage('Login successful');
        return true;
      }

      loginRetry('Login failed: no session id returned');
      return false;
    })
    .catch(err => {
      if (err.message && err.message.includes('Operation timed out')) {
        loginRetry(`Login timed out after ${TIMEOUT_HTTP}s`);
      } else {
        loginRetry('Login failed: check host, username and password');
      }
      console.error(err);
      return false;
    });
}

function afterLogin() {
  return fetchStbState()
    .then(fetchChannels)
    .then(() => { computeFavorites(); buildPanel(allChannels); })
    .catch(err => console.error('afterLogin error', err));
}

function loginRetry(reason) {
  clearTimeout(timerLoginRetry);
  const msg = `${reason}. Retry in ${LOGIN_RETRY}s`;
  updateStatusPage(msg);
  console.error(msg);
  timerLoginRetry = setTimeout(login, LOGIN_RETRY * 1000);
}

/*
─────────────────────────────────────────────────────────────────────────────
Data fetch
─────────────────────────────────────────────────────────────────────────────
*/
function fetchStbState() {
  return withAuth(() => httpGet(`/apis/devices/stbs/${hmp_stb}`))
    .then(data => {
      const d = (data && data.data) ? data.data : {};
      currentVolume = (d.volume !== undefined) ? d.volume : currentVolume;
      isMuted = (d.muted !== undefined) ? d.muted : isMuted;
      isStandby = (d.standby !== undefined) ? d.standby : isStandby;
      stbInfo.name = d.name || d.hostname || hmp_stb;
      stbInfo.ip = d.ip || 'unknown';
      stbInfo.model = d.model || 'Play STB';
      updateAboutPage();
    })
    .catch(err => console.error('fetchStbState error', err));
}

function fetchChannels() {
  updateStatusPage('Loading channels…');
  return withAuth(() => httpGet('/apis/sources'))
    .then(data => {
      const items = (data && data.data && Array.isArray(data.data)) ? data.data : [];
      allChannels = items.slice(0, MAX_CHANNELS).map(s => ({
        id: s.id, name: s.name, type: 'source',
      }));
      console.log(`HMP: loaded ${allChannels.length} channels`);
      updateStatusPage('Ready');
      return allChannels;
    })
    .catch(err => { console.error('fetchChannels error', err); updateStatusPage('Channel load failed'); });
}

function computeFavorites() {
  const favNames = hmp_fav.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  favoriteChannels = favNames
    .map(name => allChannels.find(ch => ch.name.toLowerCase() === name))
    .filter(Boolean)
    .slice(0, 10);
}

/*
─────────────────────────────────────────────────────────────────────────────
STB commands
─────────────────────────────────────────────────────────────────────────────
*/
function sendStbCommand(payload) {
  return withAuth(() => httpPost(`/apis/devices/stbs/${hmp_stb}/commands`, payload));
}

function tuneToChannel(ch) {
  if (!ch) return;
  updateStatusPage(`Tuning: ${ch.name}`);
  sendStbCommand({ command: 'set-channel', parameters: { id: ch.id, name: null, type: ch.type } })
    .then(() => { updateStatusPage(ch.name); updateLabel('widget_hmp_about_channel', ch.name); })
    .catch(err => { console.error('set-channel error', err); updateStatusPage('Channel error'); });
}

function hmpVolume(direction) {
  const delta = direction === 'up' ? VOLUME_STEP : -VOLUME_STEP;
  const newVol = Math.min(1, Math.max(0, parseFloat((currentVolume + delta).toFixed(2))));
  sendStbCommand({ command: 'set-volume', parameters: { volume: newVol } })
    .then(() => { currentVolume = newVol; updateStatusPage(`Volume: ${Math.round(newVol * 100)}%`); updateAboutPage(); })
    .catch(err => console.error('set-volume error', err));
}

function codecVolume(direction) {
  if (direction === 'up') xapi.Command.Audio.Volume.Increase();
  else xapi.Command.Audio.Volume.Decrease();
  timerVolume = setTimeout(codecVolume, CODEC_VOL_REPEAT_MS, direction);
}

function toggleMute() {
  sendStbCommand({ command: isMuted ? 'unmute' : 'mute' })
    .then(() => { isMuted = !isMuted; updateStatusPage(isMuted ? 'Muted' : 'Unmuted'); updateAboutPage(); })
    .catch(err => console.error('mute error', err));
}

function togglePower() {
  sendStbCommand({ command: isStandby ? 'standby-off' : 'standby-on' })
    .then(() => { isStandby = !isStandby; updateStatusPage(isStandby ? 'STB: Standby' : 'STB: On'); })
    .catch(err => console.error('power error', err));
}

/*
─────────────────────────────────────────────────────────────────────────────
PANEL BUILDER  (the core of the dynamic approach, like z-band buildPanel)
Channel/favorite buttons cannot be relabelled at runtime, so the entire panel
XML is assembled as a string and pushed with Panel.Save. Channel identity is
encoded as an index into displayedChannels / favoriteChannels in the WidgetId.
─────────────────────────────────────────────────────────────────────────────
*/
function buildPanel(channelsToShow) {
  displayedChannels = channelsToShow || [];

  // All-channels page rows: one full-width button per channel
  let channelRows = '';
  displayedChannels.forEach((ch, i) => {
    channelRows += channelRowXml(i, ch.name);
  });
  if (!channelRows) channelRows = emptyRowXml('No channels');

  // Favorites: two half-width buttons per row, up to 10
  let favRows = '';
  for (let i = 0; i < favoriteChannels.length; i += 2) {
    favRows += '<Row><Name>Row</Name>';
    favRows += favWidgetXml(i, favoriteChannels[i].name);
    if (favoriteChannels[i + 1]) favRows += favWidgetXml(i + 1, favoriteChannels[i + 1].name);
    favRows += '</Row>';
  }
  if (!favRows) favRows = emptyRowXml('Set favorites in config');

  const panelXml = assemblePanel(favRows, channelRows);
  xapi.Command.UserInterface.Extensions.Panel.Save({ PanelId: PANEL_ID }, panelXml)
    .then(() => { updateAboutPage(); })
    .catch(err => console.error('Panel.Save error', err));
}

function channelRowXml(index, name) {
  return `<Row><Name>${xmlEscape(name)}</Name>` +
    `<Widget><WidgetId>widget_hmp_ch_${index}</WidgetId>` +
    `<Name>${xmlEscape(name)}</Name><Type>Button</Type><Options>size=4</Options></Widget></Row>`;
}

function favWidgetXml(index, name) {
  return `<Widget><WidgetId>widget_hmp_fav_${index}</WidgetId>` +
    `<Name>${xmlEscape(name)}</Name><Type>Button</Type><Options>size=2</Options></Widget>`;
}

function emptyRowXml(label) {
  return `<Row><Name>Row</Name><Widget><WidgetId>widget_hmp_empty_${Math.random().toString(36).slice(2, 7)}</WidgetId>` +
    `<Name>${xmlEscape(label)}</Name><Type>Text</Type><Options>size=4;fontSize=normal;align=center</Options></Widget></Row>`;
}

function assemblePanel(favRows, channelRows) {
  const tvPage = `
<Page>
<Name>TV</Name>
${favRows}
<Row><Name>Row</Name>
<Widget><WidgetId>widget_hmp_voltext</WidgetId><Name>Volume   /   Mute   /   Power</Name><Type>Text</Type><Options>size=4;fontSize=normal;align=center</Options></Widget>
</Row>
<Row><Name>Row</Name>
<Widget><WidgetId>widget_hmp_vol_dn</WidgetId><Type>Button</Type><Options>size=1;icon=speaker</Options></Widget>
<Widget><WidgetId>widget_hmp_vol_up</WidgetId><Type>Button</Type><Options>size=1;icon=audio_plus</Options></Widget>
<Widget><WidgetId>widget_hmp_mute</WidgetId><Type>Button</Type><Options>size=1;icon=volume_muted</Options></Widget>
<Widget><WidgetId>widget_hmp_power</WidgetId><Type>Button</Type><Options>size=1;icon=power</Options></Widget>
</Row>
<PageId>${PAGE_TV_ID}</PageId>
<Options>hideRowNames=1</Options>
</Page>`;

  const channelsPage = `
<Page>
<Name>Channels</Name>
<Row><Name>Row</Name>
<Widget><WidgetId>widget_hmp_filter</WidgetId><Name>Filter</Name><Type>Button</Type><Options>size=2</Options></Widget>
<Widget><WidgetId>widget_hmp_reset</WidgetId><Name>Reset</Name><Type>Button</Type><Options>size=2</Options></Widget>
</Row>
${channelRows}
<PageId>${PAGE_CHANNELS_ID}</PageId>
<Options>hideRowNames=1</Options>
</Page>`;

  const aboutPage = `
<Page>
<Name>About</Name>
<Row><Name>Row</Name><Widget><WidgetId>widget_hmp_status</WidgetId><Name>Status</Name><Type>Text</Type><Options>size=4;fontSize=small;align=center</Options></Widget></Row>
<Row><Name>Row</Name>
<Widget><WidgetId>widget_hmp_about_name_lbl</WidgetId><Name>STB Name</Name><Type>Text</Type><Options>size=1;fontSize=normal;align=center</Options></Widget>
<Widget><WidgetId>widget_hmp_about_name</WidgetId><Name>-</Name><Type>Text</Type><Options>size=3;fontSize=normal;align=left</Options></Widget>
</Row>
<Row><Name>Row</Name>
<Widget><WidgetId>widget_hmp_about_ip_lbl</WidgetId><Name>STB IP</Name><Type>Text</Type><Options>size=1;fontSize=normal;align=center</Options></Widget>
<Widget><WidgetId>widget_hmp_about_ip</WidgetId><Name>-</Name><Type>Text</Type><Options>size=3;fontSize=normal;align=left</Options></Widget>
</Row>
<Row><Name>Row</Name>
<Widget><WidgetId>widget_hmp_about_vol_lbl</WidgetId><Name>Volume</Name><Type>Text</Type><Options>size=1;fontSize=normal;align=center</Options></Widget>
<Widget><WidgetId>widget_hmp_about_vol</WidgetId><Name>-</Name><Type>Text</Type><Options>size=3;fontSize=normal;align=left</Options></Widget>
</Row>
<Row><Name>Row</Name>
<Widget><WidgetId>widget_hmp_about_channel_lbl</WidgetId><Name>Channel</Name><Type>Text</Type><Options>size=1;fontSize=normal;align=center</Options></Widget>
<Widget><WidgetId>widget_hmp_about_channel</WidgetId><Name>-</Name><Type>Text</Type><Options>size=3;fontSize=normal;align=left</Options></Widget>
</Row>
<Row>
        <Name>Row</Name>
        <Widget>
          <WidgetId>widget_hmp_get_stb_list</WidgetId>
          <Name>Get STB list in Console Log</Name>
          <Type>Button</Type>
          <Options>size=3</Options>
        </Widget>
  </Row>

      <Row>
        <Name>Row</Name>
        <Widget>
          <WidgetId>mtp_widget_text_stb_paging</WidgetId>
          <Name>STB paging</Name>
          <Type>Text</Type>
          <Options>size=2;fontSize=normal;align=center</Options>
        </Widget>
        <Widget>
          <WidgetId>widget_hmp_get_stb_page_back</WidgetId>
          <Type>Button</Type>
          <Options>size=1;icon=minus</Options>
        </Widget>
        <Widget>
          <WidgetId>widget_hmp_get_stb_page_forward</WidgetId>
          <Type>Button</Type>
          <Options>size=1;icon=plus</Options>
        </Widget>
      </Row>
      
<PageId>${PAGE_ABOUT_ID}</PageId>
<Options>hideRowNames=1</Options>
</Page>`;

  return `<Extensions>
<Version>${PANEL_VERSION}</Version>
<Panel>
<Order>${PANEL_ORDER}</Order>
<PanelId>${PANEL_ID}</PanelId>
<Location>${PANEL_LOCATION}</Location>
<Icon>${PANEL_ICON}</Icon>
<Color>${PANEL_COLOR}</Color>
<Name>${PANEL_NAME}</Name>
<ActivityType>Custom</ActivityType>
${tvPage}
${channelsPage}
${aboutPage}
</Panel>
</Extensions>`;
}

/*
─────────────────────────────────────────────────────────────────────────────
Text widget updates (these DO work with SetValue, unlike Button labels)
─────────────────────────────────────────────────────────────────────────────
*/
function updateLabel(widgetId, value) {
  xapi.Command.UserInterface.Extensions.Widget.SetValue({ WidgetId: widgetId, Value: value }).catch(() => { });
}

function updateStatusPage(text) {
  const t = new Date();
  const msg = `${t.toLocaleTimeString()} - ${text}`;
  console.info(msg);
  // small delay so the panel exists before we write to it
  setTimeout(() => updateLabel('widget_hmp_status', msg), 600);
}

function updateAboutPage() {
  setTimeout(() => {
    updateLabel('widget_hmp_about_name', stbInfo.name);
    updateLabel('widget_hmp_about_ip', stbInfo.ip);
    updateLabel('widget_hmp_about_vol', `${Math.round(currentVolume * 100)}%${isMuted ? ' (muted)' : ''}`);
  }, 800);
}

/*
─────────────────────────────────────────────────────────────────────────────
Filter keypad
─────────────────────────────────────────────────────────────────────────────
*/
function openFilterKeypad() {
  xapi.Command.UserInterface.Message.TextInput.Display({
    Duration: 120,
    FeedbackId: FEEDBACK_ID_FILTER,
    Placeholder: 'Enter channel name',
    SubmitText: 'Filter',
    Text: 'Type part of a channel name',
    Title: 'Filter Channels',
  });
}

xapi.Event.UserInterface.Message.TextInput.Response.on(event => {
  if (event.FeedbackId !== FEEDBACK_ID_FILTER) return;
  const term = (event.Text || '').toLowerCase().trim();
  if (!term) { buildPanel(allChannels); return; }
  const filtered = allChannels.filter(ch => ch.name.toLowerCase().includes(term));
  updateStatusPage(`Filter "${event.Text}": ${filtered.length} result(s)`);
  buildPanel(filtered);
});

function getSetTopBoxList(pageNumber = ''){
  let paging ; 
  if (pageNumber === ''){
    paging = ''; 
  } else {
    paging = '?page=' + pageNumber; 
  }
  return withAuth(() => httpGet('/apis/devices/stbs' + paging))
    .then(data => {
      console.log('Set Top Box:', JSON.stringify(data, null, 5)); 
      const items = (data && data.data && Array.isArray(data.data)) ? data.data : [];
      if('paging' in data){
        console.log('paging', data.paging); 
      }
      allChannels = items.slice(0, MAX_CHANNELS).map(s => ({
        id: s.id, name: s.name, type: 'source',
      }));
      console.log(`HMP: loaded ${allChannels.length} channels`);
      updateStatusPage('Ready');
      return allChannels;
    })
    .catch(err => { console.error('fetchChannels error', err); updateStatusPage('Channel load failed'); });
}

/*
─────────────────────────────────────────────────────────────────────────────
Widget event handling
─────────────────────────────────────────────────────────────────────────────
*/
xapi.Event.UserInterface.Extensions.Widget.Action.on(event => {
  const id = event.WidgetId;
  console.log('log id', id); 

  if(id === 'widget_hmp_get_stb_list' && event.Type === 'clicked'){
    console.log('Get STB List');;  
    getSetTopBoxList();
    return; 
  }

  if (id === 'widget_hmp_get_stb_page_forward' && event.Type === 'clicked'){
 
    currentPageNumber += 1; 
        console.log('Get STB page forward page number:', currentPageNumber);; 
    getSetTopBoxList(currentPageNumber);
    return; 
  }

  if (id === 'widget_hmp_get_stb_page_back' && event.Type === 'clicked'){

    currentPageNumber -= 1; 
    console.log('Get STB page back, page number: ', currentPageNumber);
    getSetTopBoxList(currentPageNumber);
    return; 
  }

  // Channel buttons
  const chMatch = id.match(/^widget_hmp_ch_(\d+)$/);
  if (chMatch && event.Type === 'clicked') {
    tuneToChannel(displayedChannels[parseInt(chMatch[1], 10)]);
    return;
  }

  // Favorite buttons
  const favMatch = id.match(/^widget_hmp_fav_(\d+)$/);
  if (favMatch && event.Type === 'clicked') {
    tuneToChannel(favoriteChannels[parseInt(favMatch[1], 10)]);
    return;
  }

  if (id === 'widget_hmp_filter' && event.Type === 'clicked') { openFilterKeypad(); return; }
  if (id === 'widget_hmp_reset' && event.Type === 'clicked') { buildPanel(allChannels); return; }
  if (id === 'widget_hmp_mute' && event.Type === 'clicked') { toggleMute(); return; }
  if (id === 'widget_hmp_power' && event.Type === 'clicked') { togglePower(); return; }

  // Volume buttons
  if (id === 'widget_hmp_vol_up' || id === 'widget_hmp_vol_dn') {
    const dir = id === 'widget_hmp_vol_up' ? 'up' : 'down';
    if (VOLUME_CONTROL === 'codec') {
      if (event.Type === 'pressed') { clearTimeout(timerVolume); codecVolume(dir); }
      if (event.Type === 'released') { clearTimeout(timerVolume); }
    } else {
      if (event.Type === 'pressed') hmpVolume(dir);   // single step per press
    }
    return;
  }
});

/*
─────────────────────────────────────────────────────────────────────────────
Panel opened -> refresh state and channels (mirrors z-band panelClicked)
─────────────────────────────────────────────────────────────────────────────
*/
xapi.Event.UserInterface.Extensions.Panel.Clicked.on(event => {

  if (event.PanelId !== PANEL_ID) return;

  xapi.Command.Presentation.Start({ ConnectorId: HDMI_INPUT });

 //  xapi.Command.UserInterface.Extensions.Panel.Open({ PanelId: PANEL_ID, PageId: PAGE_TV_ID }).catch(() => { });
  fetchStbState()
    .then(fetchChannels)
    .then(() => { computeFavorites(); buildPanel(allChannels); });
});

xapi.Event.UserInterface.Extensions.Event.PageClosed.on(event =>{
  if(event.PageId.startsWith(PAGEID_PREFIX)){
    stopPresentationShare(); 
  } 
} );
/*
─────────────────────────────────────────────────────────────────────────────
Helpers
─────────────────────────────────────────────────────────────────────────────
*/
function turnOnHttpClient() {
  if (TURN_ON_HTTP_CLIENT) {
    xapi.Config.HttpClient.Mode.set('On').catch(() => { });
    xapi.Config.HttpClient.AllowInsecureHTTPS.set(ALLOW_INSECURE_HTTPS).catch(() => { });
  }
}

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function stopPresentationShare(){
  xapi.Command.Presentation.Stop();
}; 

xapi.Event.OutgoingCallIndication.on(stopPresentationShare);
xapi.Event.IncomingCallIndication.on(stopPresentationShare);
xapi.Event.CallSuccessful.on(stopPresentationShare);

