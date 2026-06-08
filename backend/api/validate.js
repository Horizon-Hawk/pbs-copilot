// POST /api/validate — check token validity without consuming it
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

  const { data, error } = await supabase
    .from('tokens')
    .select('id, used, expires_at')
    .eq('code', code)
    .single();

  if (error || !data) return res.status(200).json({ valid: false, error: 'Token not found' });
  if (data.used) return res.status(200).json({ valid: false, error: 'Token already used' });
  if (data.expires_at && new Date(data.expires_at) < new Date()) {
    return res.status(200).json({ valid: false, error: 'Token expired' });
  }

  return res.status(200).json({ valid: true });
};
