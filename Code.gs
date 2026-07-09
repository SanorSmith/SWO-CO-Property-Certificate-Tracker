/**
 * SWO & Co – Property Certificate Tracker
 * Google Apps Script – Code.gs
 *
 * Sheet name:   schedule
 * Header row:   12
 * Data rows:    13–73
 *
 * Column map:
 *   B  – Property Address (display)
 *   C  – Property Address (used in script)
 *   D  – Electrical Certificate expiry
 *   E  – Gas Certificate expiry
 *   F  – Energy Performance Certificate (EPC) expiry
 *   G  – EPC Rating
 *   H  – Borough
 *   I  – Council Tax Band
 *   J  – Tenancy Agreement date
 *   K  – Tenancy Email
 *
 * Notification email: info@swoandco.com
 * Script account:     swobtconnect@gmail.com
 *
 * Urgency bands (days until expiry):
 *   0–1   → Critical  (red)
 *   2–7   → High      (orange)
 *   8–15  → Medium    (yellow)
 *   16–30 → Low       (green)
 *   30+   → Not reported
 *
 * Functions:
 *   checkCertificateDates() – daily trigger, sends email + push notification
 *   testEmail()             – sends a test email to confirm setup
 *   doGet(e)                – serves web app UI or JSON API (?action=getAlerts)
 *   doPost(e)               – JSON API for PWA (updateCert)
 *   getAlerts()             – returns all expiring cert alerts as JSON
 *   updateCertDate(row, certField, newDate) – writes new expiry date to sheet
 *   getProperties()         – returns property address list for dropdown
 *   getPropertyDetails(row) – returns cert/tenancy data for a property row
 *   saveProperty(data)      – writes updated data back to the sheet
 *   sendPushNotification(title, message) – sends push via OneSignal
 */

// ─────────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────────

var CONFIG = {
  SHEET_NAME:   'schedule',
  HEADER_ROW:   12,
  FIRST_ROW:    13,
  LAST_ROW:     73,
  EMAIL_TO:     'info@swoandco.com',
  EMAIL_SUBJECT: 'SWO & Co – Certificate Expiry Report',

  // Column indices (1-based, matching sheet layout)
  COL_ADDRESS:   3,   // C – Property Address
  COL_ELEC:      4,   // D – Electrical Certificate
  COL_GAS:       5,   // E – Gas Certificate
  COL_EPC:       6,   // F – EPC
  COL_EPC_RATING: 7,  // G – EPC Rating
  COL_BOROUGH:   8,   // H – Borough
  COL_COUNCIL:   9,   // I – Council Tax Band
  COL_TENANCY:   10,  // J – Tenancy Agreement
  COL_EMAIL:     11,  // K – Tenancy Email
};

// ─────────────────────────────────────────────
//  MAIN: checkCertificateDates
//  Run daily via a time-driven trigger (e.g. 8am–9am)
// ─────────────────────────────────────────────

function checkCertificateDates() {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  var today = new Date();
  today.setHours(0, 0, 0, 0);

  // Buckets per certificate type
  var types = {
    'Electrical': { col: CONFIG.COL_ELEC, items: { critical: [], high: [], medium: [], low: [] } },
    'Gas':        { col: CONFIG.COL_GAS,  items: { critical: [], high: [], medium: [], low: [] } },
    'EPC':        { col: CONFIG.COL_EPC,  items: { critical: [], high: [], medium: [], low: [] } },
  };

  for (var row = CONFIG.FIRST_ROW; row <= CONFIG.LAST_ROW; row++) {
    var address = sheet.getRange(row, CONFIG.COL_ADDRESS).getValue();
    if (!address) continue;

    for (var typeName in types) {
      var col    = types[typeName].col;
      var cell   = sheet.getRange(row, col).getValue();
      if (!cell) continue;

      var expiry = new Date(cell);
      expiry.setHours(0, 0, 0, 0);
      var daysLeft = Math.round((expiry - today) / (1000 * 60 * 60 * 24));

      var bucket = getBucket(daysLeft);
      if (bucket) {
        types[typeName].items[bucket].push({
          address:  address,
          expiry:   Utilities.formatDate(expiry, Session.getScriptTimeZone(), 'dd/MM/yyyy'),
          daysLeft: daysLeft,
        });
      }
    }
  }

  // Only send if there is something to report
  var hasItems = false;
  for (var t in types) {
    var b = types[t].items;
    if (b.critical.length || b.high.length || b.medium.length || b.low.length) {
      hasItems = true;
      break;
    }
  }

  if (!hasItems) {
    Logger.log('No certificates due within 30 days. No email sent.');
    return;
  }

  // Send email
  var body = buildEmailHtml(types, today);
  MailApp.sendEmail({
    to:       CONFIG.EMAIL_TO,
    subject:  CONFIG.EMAIL_SUBJECT,
    htmlBody: body,
  });
  Logger.log('Certificate expiry report sent to ' + CONFIG.EMAIL_TO);

  // Send push notification
  var alertData = getAlerts();
  if (alertData.alerts && alertData.alerts.length > 0) {
    var critical = alertData.alerts.filter(function(a) { return a.urgency === 'critical'; }).length;
    var high     = alertData.alerts.filter(function(a) { return a.urgency === 'high'; }).length;
    var total    = alertData.alerts.length;

    var msg = total + ' certificate' + (total === 1 ? '' : 's') + ' need attention';
    if (critical > 0) msg = '⛔ ' + critical + ' CRITICAL · ' + msg;
    else if (high > 0) msg = '⚠️ ' + high + ' High priority · ' + msg;

    sendPushNotification('SWO & Co – Certificate Alert', msg);
  }
}

// ─────────────────────────────────────────────
//  WEB APP: doGet
//  Serves Index.html OR JSON API when ?action= is set
// ─────────────────────────────────────────────

function doGet(e) {
  var action = e && e.parameter && e.parameter.action;

  if (action === 'getAlerts') {
    var result = getAlerts();
    return ContentService
      .createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  }

  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('SWO & Co – Property Manager')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ─────────────────────────────────────────────
//  WEB APP: doPost
//  JSON API endpoint for the PWA
//  Body: { action: 'updateCert', row, certField, newDate }
// ─────────────────────────────────────────────

function doPost(e) {
  try {
    var data   = JSON.parse(e.postData.contents);
    var action = data.action;

    if (action === 'updateCert') {
      var result = updateCertDate(data.row, data.certField, data.newDate);
      return ContentService
        .createTextOutput(JSON.stringify(result))
        .setMimeType(ContentService.MimeType.JSON);
    }

    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: 'Unknown action' }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ─────────────────────────────────────────────
//  API: getAlerts
//  Returns all certificates expiring within 30 days
//  Used by the PWA to populate the Alerts screen
// ─────────────────────────────────────────────

function getAlerts() {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  var today = new Date();
  today.setHours(0, 0, 0, 0);
  var tz = Session.getScriptTimeZone();

  var certTypes = [
    { name: 'Electrical', col: CONFIG.COL_ELEC, field: 'electrical' },
    { name: 'Gas',        col: CONFIG.COL_GAS,  field: 'gas'        },
    { name: 'EPC',        col: CONFIG.COL_EPC,  field: 'epc'        },
  ];

  var alerts = [];

  for (var row = CONFIG.FIRST_ROW; row <= CONFIG.LAST_ROW; row++) {
    var address = sheet.getRange(row, CONFIG.COL_ADDRESS).getValue();
    if (!address) continue;

    certTypes.forEach(function(cert) {
      var cell = sheet.getRange(row, cert.col).getValue();
      if (!cell) return;

      var expiry = new Date(cell);
      expiry.setHours(0, 0, 0, 0);
      var daysLeft = Math.round((expiry - today) / (1000 * 60 * 60 * 24));
      var bucket   = getBucket(daysLeft);
      if (!bucket) return;

      alerts.push({
        id:        row + '-' + cert.field,
        row:       row,
        address:   String(address),
        certType:  cert.name,
        certField: cert.field,
        expiry:    Utilities.formatDate(expiry, tz, 'dd/MM/yyyy'),
        expiryRaw: Utilities.formatDate(expiry, tz, 'yyyy-MM-dd'),
        daysLeft:  daysLeft,
        urgency:   bucket,
      });
    });
  }

  // Sort: critical → high → medium → low, then by daysLeft ascending
  var order = { critical: 0, high: 1, medium: 2, low: 3 };
  alerts.sort(function(a, b) {
    var u = order[a.urgency] - order[b.urgency];
    return u !== 0 ? u : a.daysLeft - b.daysLeft;
  });

  return {
    success:     true,
    alerts:      alerts,
    generatedAt: Utilities.formatDate(new Date(), tz, "yyyy-MM-dd'T'HH:mm:ss"),
  };
}

// ─────────────────────────────────────────────
//  API: updateCertDate
//  Writes a new expiry date for one certificate to the sheet
//  certField: 'electrical' | 'gas' | 'epc'
// ─────────────────────────────────────────────

function updateCertDate(row, certField, newDate) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_NAME);
  row = parseInt(row, 10);

  if (isNaN(row) || row < CONFIG.FIRST_ROW || row > CONFIG.LAST_ROW) {
    return { success: false, error: 'Invalid row: ' + row };
  }

  var colMap = {
    electrical: CONFIG.COL_ELEC,
    gas:        CONFIG.COL_GAS,
    epc:        CONFIG.COL_EPC,
  };

  var col = colMap[certField];
  if (!col) return { success: false, error: 'Unknown certField: ' + certField };

  var d = new Date(newDate);
  if (isNaN(d.getTime())) return { success: false, error: 'Invalid date: ' + newDate };

  try {
    sheet.getRange(row, col).setValue(d);
    SpreadsheetApp.flush();
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ─────────────────────────────────────────────
//  PUSH: sendPushNotification
//  Sends a push via OneSignal REST API.
//  Configure keys once in Apps Script:
//    File → Project properties → Script properties
//    Keys: ONESIGNAL_APP_ID, ONESIGNAL_API_KEY, PWA_URL
// ─────────────────────────────────────────────

function sendPushNotification(title, message) {
  var props  = PropertiesService.getScriptProperties();
  var appId  = props.getProperty('ONESIGNAL_APP_ID');
  var apiKey = props.getProperty('ONESIGNAL_API_KEY');
  var pwaUrl = props.getProperty('PWA_URL') || '';

  if (!appId || !apiKey) {
    Logger.log('OneSignal not configured — skipping push. Add ONESIGNAL_APP_ID and ONESIGNAL_API_KEY to Script Properties.');
    return;
  }

  var payload = JSON.stringify({
    app_id:            appId,
    included_segments: ['All'],
    headings:          { en: title },
    contents:          { en: message },
    url:               pwaUrl,
  });

  var response = UrlFetchApp.fetch('https://onesignal.com/api/v1/notifications', {
    method:           'post',
    headers:          { 'Content-Type': 'application/json', 'Authorization': 'Basic ' + apiKey },
    payload:          payload,
    muteHttpExceptions: true,
  });

  Logger.log('OneSignal push sent. Response: ' + response.getContentText());
}

// ─────────────────────────────────────────────
//  HELPER: getBucket
// ─────────────────────────────────────────────

function getBucket(daysLeft) {
  if (daysLeft <= 1)  return 'critical';
  if (daysLeft <= 7)  return 'high';
  if (daysLeft <= 15) return 'medium';
  if (daysLeft <= 30) return 'low';
  return null;
}

// ─────────────────────────────────────────────
//  HELPER: buildEmailHtml
// ─────────────────────────────────────────────

function buildEmailHtml(types, today) {
  var dateStr = Utilities.formatDate(today, Session.getScriptTimeZone(), 'EEEE d MMMM yyyy');

  var urgencyMeta = {
    critical: { label: 'Critical – expires within 1 day',   color: '#c0392b', bg: '#fdf3f2' },
    high:     { label: 'High – expires within 7 days',      color: '#e67e22', bg: '#fef9f0' },
    medium:   { label: 'Medium – expires within 15 days',   color: '#f1c40f', bg: '#fefdf0' },
    low:      { label: 'Low – expires within 30 days',      color: '#27ae60', bg: '#f0fdf4' },
  };

  var html = '<div style="font-family:Arial,sans-serif;max-width:700px;margin:0 auto;">'
           + '<h2 style="color:#2c3e50;">SWO &amp; Co – Certificate Expiry Report</h2>'
           + '<p style="color:#7f8c8d;">Generated: ' + dateStr + '</p>';

  for (var typeName in types) {
    var buckets = types[typeName].items;
    var typeHasItems = Object.keys(buckets).some(function(b) { return buckets[b].length > 0; });
    if (!typeHasItems) continue;

    html += '<h3 style="color:#2c3e50;border-bottom:2px solid #ecf0f1;padding-bottom:6px;">'
          + typeName + ' Certificate</h3>';

    ['critical', 'high', 'medium', 'low'].forEach(function(bucket) {
      var items = buckets[bucket];
      if (!items.length) return;

      var meta = urgencyMeta[bucket];
      html += '<div style="margin-bottom:16px;">'
            + '<p style="font-weight:bold;color:' + meta.color + ';margin:0 0 6px;">'
            + meta.label + '</p>'
            + '<table style="width:100%;border-collapse:collapse;background:' + meta.bg + ';">'
            + '<tr style="background:' + meta.color + ';color:#fff;">'
            + '<th style="padding:8px;text-align:left;">Property</th>'
            + '<th style="padding:8px;text-align:left;">Expiry Date</th>'
            + '<th style="padding:8px;text-align:left;">Days Left</th>'
            + '</tr>';

      items.forEach(function(item) {
        var daysLabel = item.daysLeft < 0
          ? 'EXPIRED (' + Math.abs(item.daysLeft) + ' days ago)'
          : item.daysLeft + ' day' + (item.daysLeft === 1 ? '' : 's');
        html += '<tr>'
              + '<td style="padding:8px;border-bottom:1px solid #ddd;">' + item.address + '</td>'
              + '<td style="padding:8px;border-bottom:1px solid #ddd;">' + item.expiry + '</td>'
              + '<td style="padding:8px;border-bottom:1px solid #ddd;font-weight:bold;">' + daysLabel + '</td>'
              + '</tr>';
      });

      html += '</table></div>';
    });
  }

  html += '<p style="color:#95a5a6;font-size:12px;margin-top:24px;">'
        + 'This email was sent automatically by the SWO &amp; Co Certificate Tracker. '
        + 'Do not reply to this message.</p>'
        + '</div>';

  return html;
}

// ─────────────────────────────────────────────
//  TEST: testEmail
// ─────────────────────────────────────────────

function testEmail() {
  MailApp.sendEmail({
    to:       CONFIG.EMAIL_TO,
    subject:  'SWO Certificate Tracker – Test Email',
    htmlBody: '<p>This is a test email from the SWO &amp; Co Certificate Tracker script.</p>'
            + '<p>If you received this, email notifications are working correctly.</p>',
  });
  Logger.log('Test email sent to ' + CONFIG.EMAIL_TO);
}

// ─────────────────────────────────────────────
//  TEST: testPush
//  Run manually to confirm OneSignal push works
// ─────────────────────────────────────────────

function testPush() {
  sendPushNotification(
    'SWO & Co – Test Push',
    'Push notifications are working correctly! 🎉'
  );
}

// ─────────────────────────────────────────────
//  WEB APP BACKEND: getProperties
// ─────────────────────────────────────────────

function getProperties() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_NAME);
  var results = [];

  for (var row = CONFIG.FIRST_ROW; row <= CONFIG.LAST_ROW; row++) {
    var address = sheet.getRange(row, CONFIG.COL_ADDRESS).getValue();
    if (address) {
      results.push({ row: row, address: String(address) });
    }
  }

  return results;
}

// ─────────────────────────────────────────────
//  WEB APP BACKEND: getPropertyDetails
// ─────────────────────────────────────────────

function getPropertyDetails(row) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_NAME);
  var tz    = Session.getScriptTimeZone();

  function fmtDate(val) {
    if (!val) return '';
    try {
      return Utilities.formatDate(new Date(val), tz, 'yyyy-MM-dd');
    } catch (e) {
      return '';
    }
  }

  return {
    row:        row,
    address:    sheet.getRange(row, CONFIG.COL_ADDRESS).getValue()   || '',
    electrical: fmtDate(sheet.getRange(row, CONFIG.COL_ELEC).getValue()),
    gas:        fmtDate(sheet.getRange(row, CONFIG.COL_GAS).getValue()),
    epc:        fmtDate(sheet.getRange(row, CONFIG.COL_EPC).getValue()),
    epcRating:  sheet.getRange(row, CONFIG.COL_EPC_RATING).getValue() || '',
    borough:    sheet.getRange(row, CONFIG.COL_BOROUGH).getValue()    || '',
    council:    sheet.getRange(row, CONFIG.COL_COUNCIL).getValue()    || '',
    tenancy:    fmtDate(sheet.getRange(row, CONFIG.COL_TENANCY).getValue()),
    email:      sheet.getRange(row, CONFIG.COL_EMAIL).getValue()      || '',
  };
}

// ─────────────────────────────────────────────
//  WEB APP BACKEND: saveProperty
// ─────────────────────────────────────────────

function saveProperty(data) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_NAME);
  var row   = parseInt(data.row, 10);

  if (isNaN(row) || row < CONFIG.FIRST_ROW || row > CONFIG.LAST_ROW) {
    return { success: false, error: 'Invalid row: ' + data.row };
  }

  function parseDate(val) {
    if (!val) return '';
    var d = new Date(val);
    return isNaN(d.getTime()) ? '' : d;
  }

  try {
    sheet.getRange(row, CONFIG.COL_ELEC).setValue(parseDate(data.electrical));
    sheet.getRange(row, CONFIG.COL_GAS).setValue(parseDate(data.gas));
    sheet.getRange(row, CONFIG.COL_EPC).setValue(parseDate(data.epc));
    sheet.getRange(row, CONFIG.COL_EPC_RATING).setValue(data.epcRating || '');
    sheet.getRange(row, CONFIG.COL_BOROUGH).setValue(data.borough      || '');
    sheet.getRange(row, CONFIG.COL_COUNCIL).setValue(data.council      || '');
    sheet.getRange(row, CONFIG.COL_TENANCY).setValue(parseDate(data.tenancy));
    sheet.getRange(row, CONFIG.COL_EMAIL).setValue(data.email          || '');

    SpreadsheetApp.flush();
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}
