/**
 * SimpleLog timeline core — the pure half of the viewer MetaApp.
 *
 * Kept DOM-free and dependency-free so it runs identically in the Bot Browser
 * iframe and in `node --test` (see tests/simpleLogTimelineApp*.test.mjs). The
 * rules mirror the protocol (/protocols/simplelog v1) and the host ledger:
 * a record is accepted on its load-bearing fields, its deliverables/refs are
 * unwrapped to BARE chain URIs (Markdown dressing is presentation, the link
 * target is the artifact), and nothing here reads the indexer's rolling
 * summary fields — bodies come from the pin content endpoint or not at all.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.SimpleLogCore = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var CHAIN_URI_RE = /^(pin|metafile|metaapp):\/\/[0-9a-f]{64}i0(\.[A-Za-z0-9]{1,8})?$/;
  /** Case-insensitive scan; canonical output is always lowercase (one identity). */
  var PINID_RE = /[0-9a-f]{64}i0/i;
  var MARKDOWN_LINK_RE = /^\[[^\]]*\]\(([^)\s]+)\)$/;
  var TRAILING_PUNCT_RE = /[，。；、！？!?,;:：)）]+$/;
  var WEB2_URI_RE = /^https?:\/\//i;
  var ELLIPSIS_RE = /…|\.{3,}/;

  var KINDS = ['handoff', 'status', 'review', 'close', 'note'];

  /** Unwrap ONE deliverables/refs item to its bare chain URI, or null. */
  function unwrapChainUri(raw) {
    if (typeof raw !== 'string') return null;
    var token = raw.trim();
    var link = MARKDOWN_LINK_RE.exec(token);
    if (link) token = link[1].trim();
    for (var i = 0; i < 3; i += 1) {
      var next = token.replace(/^[`*_<\s]+/, '').replace(/[`*_>\s]+$/, '');
      if (next === token) break;
      token = next;
    }
    token = token.replace(TRAILING_PUNCT_RE, '');
    if (!token || WEB2_URI_RE.test(token) || ELLIPSIS_RE.test(token)) return null;
    if (/[<>\[\]{}]/.test(token)) return null;
    token = token.replace(PINID_RE, function (match) { return match.toLowerCase(); });
    return CHAIN_URI_RE.test(token) ? token : null;
  }

  /** The reader contract: version, kind, summary and a task anchor. */
  function isSimpleLogRecord(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    if (Number(value.v) !== 1) return false;
    if (typeof value.kind !== 'string' || !value.kind.trim()) return false;
    if (typeof value.summary !== 'string' || !value.summary.trim()) return false;
    var taskid = typeof value.taskid === 'string' ? value.taskid.trim() : '';
    var taskkey = typeof value.taskkey === 'string' ? value.taskkey.trim() : '';
    return Boolean(taskid || taskkey);
  }

  /** Parse a pin body into a record object, or null when it is not one. */
  function parseRecordBody(bodyText) {
    if (typeof bodyText !== 'string' || bodyText.indexOf('{') === -1) return null;
    var parsed;
    try {
      parsed = JSON.parse(bodyText);
    } catch (error) {
      return null;
    }
    return isSimpleLogRecord(parsed) ? parsed : null;
  }

  /** The group key a record belongs to: the on-chain anchor wins, else the free key. */
  function anchorOf(record) {
    var taskid = typeof record.taskid === 'string' ? record.taskid.trim() : '';
    if (taskid) return { key: 'pin:' + taskid, taskid: taskid, taskkey: '', label: taskid };
    var taskkey = typeof record.taskkey === 'string' ? record.taskkey.trim() : '';
    return { key: 'key:' + taskkey, taskid: '', taskkey: taskkey, label: taskkey };
  }

  function chainUriKind(uri) {
    if (uri.indexOf('metaapp://') === 0) return 'metaapp';
    if (uri.indexOf('metafile://') === 0) return 'metafile';
    return 'pinid';
  }

  function pinidOf(uri) {
    var match = PINID_RE.exec(String(uri || ''));
    return match ? match[0].toLowerCase() : null;
  }

  function uriList(value) {
    if (!Array.isArray(value)) return [];
    var out = [];
    for (var i = 0; i < value.length; i += 1) {
      var uri = unwrapChainUri(value[i]);
      if (uri && out.indexOf(uri) === -1) out.push(uri);
    }
    return out;
  }

  function isCorrection(record) {
    return /^更正[:：]/.test(String(record.summary || '').trim());
  }

  /**
   * Group entries ({ pinId, timestamp, author, globalMetaId, record }) into one
   * timeline per task anchor. Records sort oldest → newest (a log reads forward);
   * groups sort newest-activity-first. Entries whose body could not be read are
   * kept in `unread` so the viewer never presents a partial group as complete.
   */
  function buildTimeline(entries) {
    var groups = {};
    var order = [];
    var unread = [];
    for (var i = 0; i < entries.length; i += 1) {
      var entry = entries[i];
      if (!entry || !entry.record) {
        unread.push(entry || {});
        continue;
      }
      var anchor = anchorOf(entry.record);
      var group = groups[anchor.key];
      if (!group) {
        group = {
          key: anchor.key,
          taskid: anchor.taskid,
          taskkey: anchor.taskkey,
          label: anchor.label,
          records: [],
          lastTimestamp: 0,
        };
        groups[anchor.key] = group;
        order.push(anchor.key);
      }
      group.records.push(entry);
      var ts = Number(entry.timestamp) || 0;
      if (ts > group.lastTimestamp) group.lastTimestamp = ts;
    }
    var list = order.map(function (key) { return groups[key]; });
    for (var g = 0; g < list.length; g += 1) {
      list[g].records.sort(function (a, b) {
        return (Number(a.timestamp) || 0) - (Number(b.timestamp) || 0);
      });
    }
    list.sort(function (a, b) { return b.lastTimestamp - a.lastTimestamp; });
    return { groups: list, unread: unread };
  }

  /**
   * Replay view of one group: the deliverables UNION (the protocol's delivery
   * list) plus the correction chain, both derived only from record bodies.
   */
  function summarizeGroup(group) {
    var deliverables = [];
    var seen = {};
    var corrections = [];
    var authors = {};
    var byKind = {};
    var records = group && group.records ? group.records : [];
    for (var i = 0; i < records.length; i += 1) {
      var entry = records[i];
      var record = entry.record || {};
      var kind = String(record.kind || 'note');
      byKind[kind] = (byKind[kind] || 0) + 1;
      var author = entry.author || (entry.globalMetaId ? String(entry.globalMetaId).slice(0, 12) : 'unknown');
      authors[author] = true;
      var items = uriList(record.deliverables);
      for (var d = 0; d < items.length; d += 1) {
        var pinid = pinidOf(items[d]) || items[d];
        if (seen[pinid]) continue;
        seen[pinid] = true;
        deliverables.push({ uri: items[d], kind: chainUriKind(items[d]), by: author, pinId: entry.pinId });
      }
      if (isCorrection(record)) {
        corrections.push({ pinId: entry.pinId, summary: record.summary, refs: uriList(record.refs) });
      }
    }
    return {
      recordCount: records.length,
      authorCount: Object.keys(authors).length,
      byKind: byKind,
      deliverables: deliverables,
      corrections: corrections,
      firstTimestamp: records.length ? Number(records[0].timestamp) || 0 : 0,
      lastTimestamp: records.length ? Number(records[records.length - 1].timestamp) || 0 : 0,
    };
  }

  return {
    KINDS: KINDS,
    unwrapChainUri: unwrapChainUri,
    isSimpleLogRecord: isSimpleLogRecord,
    parseRecordBody: parseRecordBody,
    anchorOf: anchorOf,
    chainUriKind: chainUriKind,
    pinidOf: pinidOf,
    uriList: uriList,
    isCorrection: isCorrection,
    buildTimeline: buildTimeline,
    summarizeGroup: summarizeGroup,
  };
});
