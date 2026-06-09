// POST /api/validate — check Lemon Squeezy license key is active

const LS_VARIANT_ID = 1765538;

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { license_key } = req.body || {};
  if (!license_key) return res.status(400).json({ valid: false, error: 'license_key required' });

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

    const data = await lsRes.json();

    if (!data.valid) {
      return res.status(200).json({ valid: false, error: data.error || 'Invalid license key' });
    }

    // Ensure the key belongs to this product
    if (data.meta?.variant_id !== LS_VARIANT_ID) {
      return res.status(200).json({ valid: false, error: 'License key not valid for this product' });
    }

    // Check subscription is active
    const status = data.license_key?.status;
    if (status !== 'active') {
      return res.status(200).json({ valid: false, error: `Subscription ${status} — please renew at pbscopilot.lemonsqueezy.com` });
    }

    return res.status(200).json({ valid: true });
  } catch (e) {
    return res.status(500).json({ valid: false, error: 'Validation service unavailable' });
  }
};
