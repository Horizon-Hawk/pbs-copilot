// POST /api/consume — mark token as used after successful NavBlue submission
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: 'token required' });

  const code = token.trim().toUpperCase();

  const { error } = await supabase
    .from('tokens')
    .update({ used: true, used_at: new Date().toISOString() })
    .eq('code', code)
    .eq('used', false);

  if (error) return res.status(500).json({ error: 'Failed to consume token' });

  return res.status(200).json({ ok: true });
};
