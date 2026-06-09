// POST /api/build — validate license key then proxy Claude API call

const LS_VARIANT_ID = 1765538;

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { license_key, ...claudePayload } = req.body || {};

  if (!license_key) return res.status(401).json({ error: 'license_key required' });

  // Validate license key against Lemon Squeezy
  try {
    const lsRes = await fetch('https://api.lemonsqueezy.com/v1/licenses/validate', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Bearer ${process.env.LS_API_KEY}`
      },
      body: new URLSearchParams({
        license_key: license_key.trim(),
        instance_name: 'PBS Copilot'
      })
    });

    const lsData = await lsRes.json();

    if (!lsData.valid || lsData.meta?.variant_id !== LS_VARIANT_ID || lsData.license_key?.status !== 'active') {
      return res.status(401).json({ error: 'Invalid or expired license — check Settings ⚙' });
    }
  } catch (e) {
    return res.status(500).json({ error: 'License validation unavailable' });
  }

  // Call Claude server-side
  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(claudePayload)
    });

    const claudeData = await claudeRes.json();

    if (!claudeRes.ok) {
      return res.status(500).json({ error: `Claude error: ${claudeData?.error?.message || 'Unknown'}` });
    }

    return res.status(200).json(claudeData);
  } catch (e) {
    return res.status(500).json({ error: 'AI service unavailable' });
  }
};
