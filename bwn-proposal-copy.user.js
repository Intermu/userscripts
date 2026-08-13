// ==UserScript==
// @name         BWN Proposal Copy (Broadway National)
// @namespace    broadwaynational.bwn
// @version      0.1.0
// @downloadURL  https://raw.githubusercontent.com/Intermu/userscripts/main/bwn-proposal-copy.user.js
// @updateURL    https://raw.githubusercontent.com/Intermu/userscripts/main/bwn-proposal-copy.user.js
// @description  Copy a client proposal from an aged-out work order onto a chosen replacement WO as an un-submitted Draft, in one confirmed action. Replays Umbrava's own createDraftProposal + editProposal mutations (line items copied verbatim); never submits, deletes, or retries. Manager-gated visibility. @grant none.
// @match        https://app.umbrava.com/*
// @match        https://*.umbrava.com/*
// @run-at       document-idle
// @noframes
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  var VER = '0.1.0';   // keep in step with @version
  var DRY_RUN = false; // when true, the two WRITE mutations are logged, not sent
  console.info('[BWN PROPOSAL COPY] v' + VER + ' - copy client proposal to another WO as a Draft (createDraftProposal + editProposal replay)');

  function onProposalPage() { return /\/work-orders\/\d+/.test(location.pathname); }

  // ===== auth + gql =========================================================
  function pcIsUmbravaToken(tok) {
    try {
      var p = JSON.parse(atob(String(tok).split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      var iss = String(p.iss || '').replace(/\/+$/, '');
      if (iss !== 'https://login.umbrava.com' && iss !== 'https://umbrava.us.auth0.com') return false;
      return !(typeof p.exp === 'number' && (Date.now() / 1000) > p.exp);
    } catch (e) { return false; }
  }
  function pcAuthToken() {
    try {
      var keys = Object.keys(localStorage).filter(function (x) {
        return /@@auth0spajs@@::.*::https:\/\/app\.umbrava\.com\/api::/.test(x);
      });
      for (var i = 0; i < keys.length; i++) {
        var body = (JSON.parse(localStorage.getItem(keys[i])) || {}).body;
        var tok = (body && body.access_token) || '';
        if (tok && pcIsUmbravaToken(tok)) return tok;
      }
    } catch (e) { }
    return '';
  }
  function pcGql(op, query, variables) {
    var tok = pcAuthToken();
    if (!tok) return Promise.reject(new Error('no-umbrava-token'));
    return fetch('/api/graphql', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json' },
      body: JSON.stringify({ operationName: op, query: query, variables: variables || {} })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (j && j.errors && j.errors.length) throw new Error(j.errors[0].message || 'GraphQL error');
      return j && j.data;
    });
  }
  var ROLE_TTL_MS = 6 * 3600 * 1000;
  var _liveRank = null;
  try {
    document.addEventListener('bwn:evt', function (e) {
      var d = e && e.detail;
      if (d && d.id === 'bwn:role' && typeof d.rank === 'number') _liveRank = d.rank;
    });
  } catch (e) { }
  function rank() {
    if (typeof _liveRank === 'number') return _liveRank;
    try {
      var r = JSON.parse(localStorage.getItem('bwn:role:last') || 'null');
      if (r && r.ok && typeof r.rank === 'number' && r.ts && (Date.now() - r.ts) < ROLE_TTL_MS) return r.rank;
    } catch (e2) { }
    return null;
  }

  // ===== copy engine ========================================================
  // (mapLineItem, buildCreateVars, buildEditVars, copyProposal land here in
  //  Tasks 2-4. Kept DOM-free so the node harness can run it headless.)
  function mapLineItem() {}          // Task 2
  function buildCreateVars() {}      // Task 3
  function buildEditVars() {}        // Task 3
  function copyProposal() {}         // Task 4

  // ===== ui =================================================================
  // (row button + drawer + picker land here in Task 5.)

})();
