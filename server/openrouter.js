const db = require('./db');
const { postComment, isUserAuthConfigured } = require('./reddit');

const MODEL = 'gpt-4o-mini';
const API_URL = 'https://api.openai.com/v1/chat/completions';

async function chat(systemPrompt, userPrompt) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY must be set in .env');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout

  try {
    console.log(`[AI] Calling OpenAI (${MODEL})...`);
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 1000,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenRouter API error (${res.status}): ${text}`);
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content?.trim() || '';
    console.log(`[AI] Response received (${content.length} chars)`);
    return content;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('OpenRouter request timed out after 30s');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function scorePost(post) {
  const cfg = db.getAllConfig();

  const system = `You are a relevance scorer. Given a Reddit post and a product description, rate how relevant the post is for leaving a helpful comment that could naturally mention the product.

Product: ${cfg.product_url}
What it does: ${cfg.product_desc}

Respond with ONLY valid JSON: {"score":"high|med|low","reason":"one sentence why"}`;

  const user = `Subreddit: ${post.subreddit}
Title: ${post.title}
Body: ${post.body || '(no body)'}`;

  const raw = await chat(system, user);

  try {
    // Extract JSON from response (handle markdown code blocks)
    const jsonMatch = raw.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) throw new Error('No JSON found');
    const parsed = JSON.parse(jsonMatch[0]);
    const score = ['high', 'med', 'low'].includes(parsed.score) ? parsed.score : 'low';
    return { score, reason: parsed.reason || '' };
  } catch {
    console.error('Failed to parse score response:', raw);
    return { score: 'low', reason: 'Could not parse AI response' };
  }
}

async function draftComment(post) {
  const cfg = db.getAllConfig();

  const system = `You are helping a developer promote their product on Reddit by being genuinely helpful.

Product: ${cfg.product_url}
What it does: ${cfg.product_desc}
Style guide: ${cfg.comment_style}

Write a Reddit comment that:
1. Actually answers or engages with their question helpfully
2. If relevant, naturally mentions this product as something that could help — don't force it
3. Sounds like a real developer, not marketing copy
4. Is 3-5 sentences max
5. Ends with the full URL (including https://) only if mentioning the product — never just the domain name

Reply with ONLY the comment text. No quotes. No preamble.`;

  const user = `Subreddit: ${post.subreddit}
Title: "${post.title}"
Body: "${post.body || '(no body)'}"`;

  return await chat(system, user);
}

async function scoreAndDraftPosts(postIds) {
  const results = [];
  const total = postIds.length;
  const startTime = Date.now();

  for (let i = 0; i < postIds.length; i++) {
    const id = postIds[i];
    const post = db.getPost(id);
    if (!post) continue;

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    const pct = ((i / total) * 100).toFixed(0);
    console.log(`[AI] [${i + 1}/${total}] (${pct}%) Scoring "${post.title.slice(0, 60)}..." [${post.subreddit}] (${elapsed}s elapsed)`);

    try {
      // Score
      const { score, reason } = await scorePost(post);
      db.updatePost(id, { score, score_reason: reason });
      console.log(`[AI] [${i + 1}/${total}] → ${score.toUpperCase()} — ${reason.slice(0, 80)}`);

      // Draft only for high/med
      if (score !== 'low') {
        console.log(`[AI] [${i + 1}/${total}] Drafting comment...`);
        const comment = await draftComment(post);
        db.updatePost(id, { drafted_comment: comment });
        console.log(`[AI] [${i + 1}/${total}] ✓ Comment drafted (${comment.length} chars)`);

        // Auto-post only for high-scored posts
        if (score === 'high' && isUserAuthConfigured()) {
          try {
            console.log(`[AI] [${i + 1}/${total}] Auto-posting to Reddit...`);
            await postComment(post.id, comment);
            db.updatePost(id, { status: 'approved' });
            console.log(`[AI] [${i + 1}/${total}] ✓ Posted to Reddit`);
          } catch (postErr) {
            console.error(`[AI] [${i + 1}/${total}] ✗ Post failed: ${postErr.message}`);
          }
        }
      }

      results.push({ id, score, reason });
    } catch (err) {
      console.error(`[AI] [${i + 1}/${total}] ✗ FAILED for ${id}: ${err.message}`);
      results.push({ id, error: err.message });
    }

    // Rate limit: 2s between AI calls
    await new Promise(r => setTimeout(r, 2000));
  }

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(0);
  const scored = results.filter(r => r.score).length;
  const highs = results.filter(r => r.score === 'high').length;
  const meds = results.filter(r => r.score === 'med').length;
  const errors = results.filter(r => r.error).length;
  console.log(`[AI] Done: ${scored} scored (${highs} high, ${meds} med), ${errors} errors, ${totalTime}s total`);

  return results;
}

module.exports = { scorePost, draftComment, scoreAndDraftPosts };
