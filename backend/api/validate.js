// POST /api/validate — verify a single-use submission token
// Body: { token: "COPILOT-XXXX-XXXX" }

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { token } = req.body || {};
  if (!token || typeof token !== 'string') {
    return res.status(400).json({ error: 'token required' });
  }

  const code = token.trim().toUpperCase();

  // Look up the token
  const { data, error } = await supabase
    .from('tokens')
    .select('id, used, expires_at')
    .eq('code', code)
    .single();

  if (error || !data) {
    return res.status(200).json({ valid: false, error: 'Token not found' });
  }

  if (data.used) {
    return res.status(200).json({ valid: false, error: 'Token already used' });
  }

  if (data.expires_at && new Date(data.expires_at) < new Date()) {
    return res.status(200).json({ valid: false, error: 'Token expired' });
  }

  // Mark used
  const { error: updateError } = await supabase
    .from('tokens')
    .update({ used: true, used_at: new Date().toISOString() })
    .eq('id', data.id);

  if (updateError) {
    return res.status(500).json({ error: 'Failed to redeem token' });
  }

  return res.status(200).json({ valid: true });
}
