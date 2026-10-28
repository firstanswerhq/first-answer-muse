// The front desk agent. Muse Spark runs the conversation; every number it says comes from a tool call.
// With no MODEL_API_KEY set, a small scripted brain runs the same tools so anyone can try the flow.

import { business, serviceList } from './business.js';
import * as engine from './engine.js';
import { hasKey, sparkChat } from './muse.js';
import { demoTurn } from './demo.js';

const threads = new Map(); // threadId -> { messages, phone, ctx }

export function resetThreads() {
  threads.clear();
}

export function getThread(id) {
  if (!threads.has(id)) threads.set(id, { messages: [], phone: null, ctx: {}, events: [] });
  return threads.get(id);
}

export const SYSTEM = () => `You are the front desk for ${business.name}, an exterior cleaning company in ${business.city}, texting with a customer.
Owner: ${business.owner}. Service area: ${business.serviceArea}. Hours: Mon-Sat 8 AM to 5 PM.
Services and policies are only what the tools return.

Rules:
- Reply like a friendly person texting: 1 to 3 short sentences, no lists unless offering times, no emoji.
- NEVER state a price, a total, a duration or an open time unless a tool returned it in this conversation. If you don't have it, call the tool.
- To quote windows you need a window count: ask for a photo of the front of the house (we count the windows from it) or the number.
- To quote driveway or gutters you need the size tier (1, 2 or 3-car driveway; one, two or three-story home).
- After a quote, offer open times from open_times. To book you need: the time they pick, their name and the service address. Then call book_job.
- When book_job succeeds, confirm the day, time, total and address in one message and say no deposit is needed.
- If something is outside these services or the customer is upset, call hand_to_owner and tell them ${business.owner} will text back.
- If a [PHOTO] or [VOICEMAIL] note appears, use what it says; don't ask again for what it already answered.`;

export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_services',
      description: 'The services, prices and policies of the business.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'quote_job',
      description: 'Price a job from the real price list. windows needs count; driveway needs tier small|medium|large; gutters needs tier one|two|three.',
      parameters: {
        type: 'object',
        properties: {
          service: { type: 'string', enum: ['windows', 'driveway', 'gutters'] },
          count: { type: 'integer', description: 'windows only: number of windows' },
          tier: { type: 'string', description: 'driveway: small|medium|large; gutters: one|two|three' },
        },
        required: ['service'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_times',
      description: 'Real open start times long enough for this job. Call after quote_job.',
      parameters: {
        type: 'object',
        properties: {
          service: { type: 'string', enum: ['windows', 'driveway', 'gutters'] },
          count: { type: 'integer' },
          tier: { type: 'string' },
        },
        required: ['service'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'book_job',
      description: 'Book the job. slot must be one returned by open_times.',
      parameters: {
        type: 'object',
        properties: {
          slot: { type: 'string', description: 'the slot id, like 2026-10-29T08' },
          service: { type: 'string', enum: ['windows', 'driveway', 'gutters'] },
          count: { type: 'integer' },
          tier: { type: 'string' },
          customer: { type: 'string', description: "customer's name" },
          address: { type: 'string', description: 'service address' },
        },
        required: ['slot', 'service', 'customer', 'address'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'hand_to_owner',
      description: 'Flag the conversation for the owner to answer personally.',
      parameters: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'], additionalProperties: false },
    },
  },
];

export function runTool(thread, name, args, now) {
  switch (name) {
    case 'list_services':
      return { services: serviceList(), policies: business.policies };
    case 'quote_job': {
      const q = engine.quote(args);
      if (q.ok) thread.ctx.quote = q;
      return q;
    }
    case 'open_times': {
      const q = engine.quote(args);
      if (!q.ok) return q;
      const times = engine.openTimes({ hours: q.hours, limit: 3, now });
      thread.ctx.offered = times;
      return { jobHours: q.hours, times };
    }
    case 'book_job': {
      const r = engine.book({ ...args, phone: thread.phone, channel: thread.ctx.channel || 'text', now });
      if (r.ok) {
        thread.ctx.booking = r.booking;
        if (thread.ctx.leadId) engine.updateLead(thread.ctx.leadId, { status: 'booked', bookingId: r.booking.id, name: r.booking.customer });
      }
      return r;
    }
    case 'hand_to_owner':
      thread.ctx.handoff = args.reason;
      if (thread.ctx.leadId) engine.updateLead(thread.ctx.leadId, { status: 'needs owner', note: args.reason });
      return { ok: true, note: `${business.owner} has been texted and will reply personally.` };
    default:
      return { ok: false, error: `Unknown tool ${name}` };
  }
}

// Add a system note the customer doesn't see (photo read, voicemail transcript).
export function addNote(threadId, note) {
  const t = getThread(threadId);
  t.messages.push({ role: 'developer', content: note });
}

// One customer turn in, one reply out. Returns { reply, tools: [{name,args,result}], mode }.
export async function handleMessage({ threadId, text, phone, now = new Date() }) {
  const t = getThread(threadId);
  if (phone) t.phone = phone;
  if (text) t.messages.push({ role: 'user', content: text });
  const trace = [];

  if (!hasKey()) {
    const reply = demoTurn(t, text || '', (name, args) => {
      const result = runTool(t, name, args, now);
      trace.push({ name, args, result });
      return result;
    });
    t.messages.push({ role: 'assistant', content: reply });
    return { reply, tools: trace, mode: 'demo' };
  }

  const messages = [{ role: 'developer', content: SYSTEM() }, ...t.messages];
  for (let step = 0; step < 6; step++) {
    const { message } = await sparkChat({ messages, tools: TOOLS });
    messages.push(message);
    t.messages.push(message);
    if (!message.tool_calls?.length) {
      return { reply: (message.content || '').trim(), tools: trace, mode: 'muse' };
    }
    for (const call of message.tool_calls) {
      let args = {};
      try {
        args = JSON.parse(call.function.arguments || '{}');
      } catch {
        args = {};
      }
      const result = runTool(t, call.function.name, args, now);
      trace.push({ name: call.function.name, args, result });
      const toolMsg = { role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) };
      messages.push(toolMsg);
      t.messages.push(toolMsg);
    }
  }
  const reply = `Thanks! ${business.owner} will text you back shortly.`;
  t.messages.push({ role: 'assistant', content: reply });
  return { reply, tools: trace, mode: 'muse' };
}
