const Lead = require('../models/lead');
const calendlyService = require('./calendlyService');
const mudslideService = require('./mudslideService');
const ApiError = require('./apiError');

async function listLeads(userDir, opts) {
  return Lead.list(userDir, opts);
}

async function updateLead(userDir, leadId, patch) {
  const lead = await Lead.findByIdForUser(userDir, leadId);
  if (!lead) return null;
  return lead.updateNotes(patch.notes);
}

async function deleteLead(userDir, leadId) {
  const lead = await Lead.findByIdForUser(userDir, leadId);
  if (!lead) return false;
  await lead.delete();
  return true;
}

// Orchestrates a booking → lead: validates the event belongs to the
// connected account and matches the given meeting, resolves the invitee's
// phone, sends the WhatsApp message, and stores the resulting lead. Throws
// ApiError with the right status for the route to surface directly (not
// found / ownership mismatch), rather than the route hand-rolling each check.
async function createLeadFromCalendlyEvent(userDir, token, meetingId, eventUri, inviteeUri) {
  const config = await calendlyService.readConfig(userDir, token);
  if (!config.connected) throw new ApiError(404, 'Calendly not connected');

  const meeting = config.meetings?.[meetingId];
  if (!meeting) throw new ApiError(404, 'Meeting not found');

  const event = await calendlyService.fetchEventDetails(userDir, token, eventUri);

  // Never trust event_uri/invitee_uri as authorization on their own — confirm
  // this event actually belongs to the connected Calendly account first.
  const belongsToUser = (event.event_memberships || []).some(m => m.user === config.calendlyUserUri);
  if (!belongsToUser) throw new ApiError(403, 'Event does not belong to the connected Calendly account');

  if (event.event_type !== meeting.eventTypeUri) {
    throw new ApiError(400, 'Event type does not match this meeting configuration');
  }

  const { name, email, phone, phoneSource } = await calendlyService.getUserPhoneFromEvent(
    userDir, token, inviteeUri, meeting.phoneQuestionName
  );

  const sourceData = {
    eventUri, inviteeUri, eventTypeUri: event.event_type,
    eventName: event.name, eventStartTime: event.start_time, eventEndTime: event.end_time,
    phoneSource
  };

  if (!phone) {
    const lead = Lead.new({ userDir, name, email, phone: null, source: 'calendly', sourceData, status: 'no_phone' });
    await lead.save();
    return { status: 'no_phone' };
  }

  const message = calendlyService.resolveMessageTemplate(meeting.messageTemplate, {
    name, eventName: event.name, eventStartTime: event.start_time
  });

  let status, messageSent = null, sendError = null;
  try {
    await mudslideService.sendMessage(userDir, token, phone, message);
    status = 'sent';
    messageSent = message;
  } catch (err) {
    status = 'failed';
    sendError = err.message;
  }

  const lead = Lead.new({ userDir, name, email, phone, source: 'calendly', sourceData, status, messageSent, sendError });
  await lead.save();
  return { status };
}

module.exports = { listLeads, updateLead, deleteLead, createLeadFromCalendlyEvent };
