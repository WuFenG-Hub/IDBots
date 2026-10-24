/**
 * AgentBrowser bridge helper for the Motion Video Arena MetaApp.
 *
 * The Bot Browser chrome (agent-browser-ui `dist/browser/app.js`) answers
 * postMessage `{type:'agent-browser:request', version:1, id, method, params}`
 * from the rendered MetaApp iframe with `agent-browser:response` (correlated
 * by id) and pushes `agent-browser:event` notifications. The MetaApp itself
 * must install the client side of that protocol — nothing injects
 * `window.AgentBrowser` into the frame for us. This file is that standard
 * client (same request/on/navigate contract as the llmchess MetaApp helper),
 * loaded BEFORE app.js, plus host-presence probing with timeouts so the app
 * can degrade to a read-only state when no host answers.
 *
 * The Arena stays a plain consumer: no signer selection, no confirmation UI,
 * and no phase-2 retry of its own — the Browser chrome owns the confirmation
 * card and the two-phase metaid.pin.write flow.
 */
(function (global) {
  'use strict';

  var PROTOCOL_VERSION = 1;
  var REQUEST_TYPE = 'agent-browser:request';
  var RESPONSE_TYPE = 'agent-browser:response';
  var EVENT_TYPE = 'agent-browser:event';
  var NAVIGATE_TYPE = 'agent-browser:navigate';

  function installAgentBrowserHelper() {
    if (typeof global.window === 'undefined') return null;
    var bridge = global.window.AgentBrowser || {};
    var installed = !!bridge.__arenaHelperInstalled;
    var callbacks = {};
    var listeners = {};
    var nextId = 1;

    function postToParent(message) {
      var parent = global.window.parent;
      if (parent && typeof parent.postMessage === 'function') {
        parent.postMessage(message, '*');
      }
    }

    if (!installed) {
      bridge.request = function request(input) {
        var id = 'arena-req-' + nextId++;
        var timeoutMs = input && typeof input.timeoutMs === 'number' ? input.timeoutMs : 0;
        return new Promise(function (resolve, reject) {
          var timer = null;
          callbacks[id] = function (error, result) {
            if (timer !== null) clearTimeout(timer);
            if (error) reject(error);
            else resolve(result);
          };
          if (timeoutMs > 0) {
            timer = setTimeout(function () {
              var pending = callbacks[id];
              delete callbacks[id];
              if (!pending) return;
              var error = new Error('AgentBrowser bridge timeout: no host response within ' + timeoutMs + 'ms.');
              error.code = 'bridge_timeout';
              pending(error);
            }, timeoutMs);
          }
          postToParent({
            type: REQUEST_TYPE,
            version: PROTOCOL_VERSION,
            id: id,
            method: String((input && input.method) || ''),
            params: (input && input.params) || {},
          });
        });
      };

      bridge.on = function on(eventName, handler) {
        (listeners[eventName] = listeners[eventName] || []).push(handler);
        return function unsubscribe() {
          listeners[eventName] = (listeners[eventName] || []).filter(function (h) { return h !== handler; });
        };
      };

      bridge.navigate = function navigate(uri) {
        postToParent({ type: NAVIGATE_TYPE, version: PROTOCOL_VERSION, uri: String(uri || '') });
      };

      bridge.__arenaHelperInstalled = true;

      global.window.addEventListener('message', function (event) {
        var data = (event && event.data) || {};
        if (data.type === RESPONSE_TYPE && callbacks[data.id]) {
          var callback = callbacks[data.id];
          delete callbacks[data.id];
          if (data.ok) callback(null, data.result || {});
          else {
            var error = new Error((data.error && data.error.message) || 'AgentBrowser request failed');
            error.code = (data.error && data.error.code) || 'bridge_error';
            callback(error);
          }
        }
        if (data.type === EVENT_TYPE) {
          (listeners[data.event] || []).forEach(function (handler) {
            try { handler(data.payload || {}); } catch (error) { /* listener bugs must not break the bridge */ }
          });
        }
      });
    }

    global.window.AgentBrowser = bridge;
    return bridge;
  }

  /**
   * Probe for a live host: asks browser.actor.current with a bounded wait.
   * In the Bot Browser this may surface the identity-disclosure consent card
   * (user approval can exceed the timeout — a timeout means "no host
   * answered", denial resolves as a live host with no disclosed actor).
   * Resolves { host: true|false, actor: object|null, error: string }.
   */
  function probeBrowserHost(timeoutMs) {
    var wait = typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : 8000;
    return new Promise(function (resolve) {
      var bridge = installAgentBrowserHelper();
      if (!bridge || !global.window.AgentBrowser || global.window.parent === global.window) {
        resolve({ host: false, actor: null, error: 'no-parent-frame' });
        return;
      }
      bridge.request({ method: 'browser.actor.current', timeoutMs: wait })
        .then(function (result) {
          resolve({ host: true, actor: (result && result.actor) || null, error: '' });
        })
        .catch(function (error) {
          if (error && error.code === 'bridge_timeout') {
            resolve({ host: false, actor: null, error: 'bridge_timeout' });
            return;
          }
          // Live host that refused disclosure (consent denied / unsupported):
          // the bridge is usable; the actor simply stays undisclosed.
          resolve({ host: true, actor: null, error: (error && error.message) || 'actor-not-disclosed' });
        });
    });
  }

  var helper = {
    installAgentBrowserHelper: installAgentBrowserHelper,
    probeBrowserHost: probeBrowserHost,
  };

  global.MotionVideoArenaBridgeHelper = helper;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = helper;
  }

  if (typeof global.window !== 'undefined' && typeof global.document !== 'undefined') {
    installAgentBrowserHelper();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
