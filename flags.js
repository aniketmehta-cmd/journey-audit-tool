/*
  Journey Audit Tool — Data Quality Flag Rules
  ====================================================================
  This file defines the rules that power the "Data Quality" tab.
  Each rule looks at the loaded journey dataset and decides whether
  to "raise a flag" — pointing at journeys that match some condition
  worth a second look.

  HOW TO ADD A NEW FLAG RULE
  --------------------------
  Each rule is a function. It receives the full list of journeys
  and returns one of:
    - null            (rule did not trigger — no flag)
    - a flag object   (rule triggered — push this to the flag list)

  A flag object looks like:
  {
    type: 'good' | 'warn' | 'bad',     // visual style (green / amber / red)
    label: 'Investigate',              // short uppercase label
    title: 'Flag heading',             // the H4 shown to the user
    desc: 'Plain-English description', // body paragraph
    journeys: [...]                    // array of journey objects this rule matched
  }

  Then add the function to the FLAG_RULES array at the bottom.
  That's it — the app will pick it up automatically.

  IMPORTANT
  ---------
  - Rules must be MECHANICAL — i.e. derived from the data itself.
  - Avoid making interpretive claims (e.g. "this journey is broken").
  - Stick to facts: "this journey shows status X but metric Y is Z".
  - Each rule should be self-contained — no shared state between rules.
*/


// ====================================================================
// RULE 1: Running journeys with zero sends
// ====================================================================
function flagSilentRunning(journeys) {
  const matches = journeys.filter(j =>
    j.status === 'Running' && j.totals.sent === 0 && j.msg_nodes > 0
  );
  if (matches.length === 0) return null;
  return {
    type: 'bad',
    label: 'Investigate',
    title: 'Running journeys with zero sends',
    desc: `${matches.length} journey${matches.length>1?'s are':' is'} flagged Running but have never sent a message. Most likely cause: the entry condition references an event that's no longer being fired, or the segment criteria never match. Either fix the entry condition or archive.`,
    journeys: matches,
  };
}


// ====================================================================
// RULE 2: Duplicate journey names
// ====================================================================
function flagDuplicateNames(journeys) {
  const byName = {};
  journeys.forEach(j => {
    (byName[j.name] = byName[j.name] || []).push(j);
  });
  const dupGroups = Object.values(byName).filter(group => group.length > 1);
  if (dupGroups.length === 0) return null;
  const flat = dupGroups.flat();
  return {
    type: 'warn',
    label: 'Check for deprecated versions',
    title: 'Journey names used by multiple Journey IDs',
    desc: `${dupGroups.length} journey name${dupGroups.length>1?'s are':' is'} shared across multiple Journey IDs. Often a sign of a deprecated version that should be archived for hygiene. Sometimes it's intentional (e.g. an A/B variant) — review and confirm.`,
    journeys: flat,
  };
}


// ====================================================================
// RULE 3: Push-heavy journeys (fatigue risk)
// ====================================================================
function flagPushHeavy(journeys) {
  const matches = journeys.filter(j => {
    const push = j.by_channel?.Push?.nodes || 0;
    const wa   = j.by_channel?.WhatsApp?.nodes || 0;
    return push >= 10 && wa <= 1;
  });
  if (matches.length === 0) return null;
  return {
    type: 'warn',
    label: 'Fatigue risk',
    title: 'Push-heavy journeys (≥10 Push nodes vs ≤1 WhatsApp)',
    desc: `${matches.length} journey${matches.length>1?'s lean':' leans'} heavily on push notifications. Push CVR-per-message is typically 5-8× lower than WhatsApp CVR. Risk: a customer who sees too many pushes mutes notifications, removing the channel entirely. Confirm Global Campaign Limits are tight.`,
    journeys: matches,
  };
}


// ====================================================================
// RULE 4: Webhook-only journeys
// ====================================================================
function flagWebhookOnly(journeys) {
  const matches = journeys.filter(j => {
    if (!j.nodes || j.nodes.length === 0) return false;
    return j.nodes.every(n => n.channel === 'Webhook');
  });
  if (matches.length === 0) return null;
  return {
    type: 'good',
    label: 'Likely fine — flagging for reporting hygiene',
    title: 'Webhook-only (background action) journeys',
    desc: `${matches.length} journey${matches.length>1?'s have':' has'} only Webhook nodes — no actual customer-facing messages. The "Total Sent" count for these is webhook trigger fires, not messages delivered. If these journeys are included in topline "messages sent" reporting to leadership, that number is inflated. Tag them as "internal-action" to filter out of comm-volume dashboards.`,
    journeys: matches,
  };
}


// ====================================================================
// RULE 5: WhatsApp/SMS messages without delivery data
// ====================================================================
function flagMissingDeliveryData(journeys) {
  const matches = journeys.filter(j => {
    let hasWaSms = false, hasZeroDelivery = false;
    j.nodes.forEach(n => {
      if (n.channel === 'WhatsApp' || n.channel === 'SMS') {
        hasWaSms = true;
        if (n.sent > 0 && n.delivered === 0) hasZeroDelivery = true;
      }
    });
    return hasWaSms && hasZeroDelivery;
  });
  if (matches.length === 0) return null;
  return {
    type: 'warn',
    label: 'Tracking gap',
    title: 'WhatsApp/SMS nodes with no delivery data populated',
    desc: `${matches.length} journey${matches.length>1?'s have':' has'} WA/SMS nodes where Total Sent > 0 but Total Delivered = 0. Either a tracking issue in CleverTap, or the journey is too new and delivery metrics haven't caught up. Worth checking the WA Business API webhook configuration.`,
    journeys: matches,
  };
}


// ====================================================================
// RULE 6: No Goal events configured
// ====================================================================
function flagNoGoals(journeys) {
  const matches = journeys.filter(j =>
    (!j.goals || j.goals.length === 0) && j.totals.sent > 0
  );
  if (matches.length === 0) return null;
  return {
    type: 'warn',
    label: 'Attribution gap',
    title: 'Journeys with no Goal events configured',
    desc: `${matches.length} journey${matches.length>1?'s have':' has'} no Goal 1/2/3 names populated. Without configured goals, direct conversion attribution can't be measured. Some of these may be webhook-only (where this is expected) — but for message journeys, add at least one Goal event.`,
    journeys: matches,
  };
}


// ====================================================================
// RULE 7: Paused journeys still in the workspace
// ====================================================================
function flagPausedJourneys(journeys) {
  const matches = journeys.filter(j => j.status === 'Paused');
  if (matches.length === 0) return null;
  return {
    type: 'good',
    label: 'For archival review',
    title: 'Paused journeys currently in the workspace',
    desc: `${matches.length} journey${matches.length>1?'s are':' is'} paused. If they've been superseded by newer versions, archive them to keep the workspace clean. If they're intentionally on standby (seasonal, etc.), keep them. Sort by Start date in the Journeys tab to see the oldest ones first.`,
    journeys: matches,
  };
}


// ====================================================================
// FLAG_RULES — the master list. Add new rules here.
// Order = order shown in the Data Quality tab.
// ====================================================================
window.FLAG_RULES = [
  flagSilentRunning,
  flagDuplicateNames,
  flagPushHeavy,
  flagWebhookOnly,
  flagMissingDeliveryData,
  flagNoGoals,
  flagPausedJourneys,
];
