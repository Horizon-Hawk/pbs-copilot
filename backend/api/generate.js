// POST /api/generate — admin: create a new single-use token
// Body: { admin_key: "...", note: "optional" }
// Returns: { token: "COPILOT-XXXX-XXXX" }

import { createClient } from '@supabase/supabase-js';
import { randomBytes } from 'crypto';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

function generateCode() {
  const bytes = randomBytes(5);
  const hex = bytes.toString('hex').toUpperCase();
  return `COPILOT-${hex.slice(0, 4)}-${hex.slice(4, 8)}`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { admin_key, note } = req.body || {};
  if (admin_key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const code = generateCode();

  const { error } = await supabase.from('tokens').insert({
    code,
    used: false,
    note: note || null,
    created_at: new Date().toISOString(),
    expires_at: null  // no expiry by default
  });

  if (error) {
    return res.status(500).json({ error: 'Failed to create token' });
  }

  return res.status(200).json({ token: code });
}
