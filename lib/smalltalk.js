// Greetings and thanks do not need a model.
//
// Making them depend on one is how a plain "Hi" ends in "I could not pull a clear answer
// together": a provider outage should cost a real question its answer, never a greeting.
// The canned line is also the better reply here, because it names what the agent can do.
const WORD = '(?:hi+|hey+|hello+|yo|salam|salaam|assalam\\s*(?:u|o|ou)?\\s*alaikum|as-?salamu\\s*alaikum|good\\s+(?:morning|afternoon|evening|day))';
// Anchored to the whole message: "Hello? When is the next post" is a question that opens with a
// greeting, not a greeting.
const GREETING = new RegExp('^' + WORD + '[\\s!.,\u2026]*$', 'i');
const THANKWORD = '(?:thank(?:s| you)?|shukran|jazak ?allahu ?khayr(?:an)?|barak ?allahu ?feek)';
const THANKS = new RegExp('^' + THANKWORD + '[\\s!.,\u2026]*$', 'i');

const GREETING_REPLY = 'Wa alaikum assalam. Ready when you are: ask for a preview, a post, the comments, or how the week went.';
const THANKS_REPLY = 'Anytime.';

// Returns { kind, reply } for small talk, or null for anything that deserves a real answer.
// Length is the guard: a greeting is short, and a question that happens to start with
// "hello" and run to forty characters is a question.
function answer(text) {
  const s = String(text == null ? '' : text).trim();
  if (!s || s.length > 40) return null;
  if (/^\//.test(s)) return null;                 // commands belong to commands.handle
  if (/\?$/.test(s)) return null;                 // a question mark is a question
  const stripped = s.replace(/[!.…]+$/, '').trim();
  if (THANKS.test(stripped)) return { kind: 'thanks', reply: THANKS_REPLY };
  if (GREETING.test(stripped)) return { kind: 'greeting', reply: GREETING_REPLY };
  return null;
}

module.exports = { answer, GREETING_REPLY, THANKS_REPLY };
