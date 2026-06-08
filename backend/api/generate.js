const { createClient } = require('@supabase/supabase-js');
const { randomBytes } = require('crypto');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

function generateCode() {
  const hex = randomBytes(4).toString('hex').toUpperCase();
  return `COPILOT-${hex.slice(0, 4)}-${hex.slice(4, 8)}`;
}

module.exports = async function handler(req, res) {
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
    created_at: new Date().toISOString()
  });

  if (error) {
    return res.status(500).json({ error: 'Failed to create token', detail: error.message });
  }

  return res.status(200).json({ token: code });
};
