with open('selloship.js', 'r') as f:
    content = f.read()

old = '''async function getServiceability(token, { pincode, weight, paymentMode } = {}) {
  try {
    const res = await axios.get(`${BASE}/serviceability`, {
      headers: authHeaders(token),
      params: {
        pincode,
        weight:      String(Math.round((parseFloat(weight) || 0.5) * 1000)),
        paymentMode: (paymentMode || 'PREPAID').toUpperCase()
      },
      timeout: TIMEOUT_TRACK
    });
    if (res.data?.status === 'SUCCESS' && Array.isArray(res.data?.couriers))
      return res.data.couriers;
    return [];
  } catch (_) { return []; }
}'''

new = '''async function getServiceability(token, { pincode, weight, paymentMode } = {}) {
  const weightGrams = String(Math.round((parseFloat(weight) || 0.5) * 1000));
  const params = {
    pincode:     pincode || '',
    weight:      weightGrams,
    paymentMode: (paymentMode || 'PREPAID').toUpperCase()
  };
  let res;
  try {
    res = await axios.get(`${BASE}/serviceability`, {
      headers: authHeaders(token),
      params,
      timeout: TIMEOUT_TRACK
    });
  } catch (err) {
    const msg = err?.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error('[Selloship serviceability] HTTP error:', msg);
    throw new Error('Selloship serviceability failed: ' + msg);
  }

  console.log('[Selloship serviceability] response:', JSON.stringify(res.data).slice(0, 600));

  const d = res.data;
  // Handle multiple possible response shapes
  const isSuccess = d?.status === 'SUCCESS' || d?.Status === 'SUCCESS';
  if (isSuccess) {
    const list = d.couriers || d.Couriers || d.data || d.courierList || [];
    if (Array.isArray(list)) return list;
    if (typeof list === 'object' && list !== null) return Object.values(list);
    return [];
  }
  const errMsg = d?.message || d?.Message || d?.error || JSON.stringify(d);
  throw new Error('Selloship serviceability: ' + errMsg);
}'''

if old in content:
    content = content.replace(old, new)
    with open('selloship.js', 'w') as f:
        f.write(content)
    print("PATCHED OK")
else:
    print("NOT FOUND — checking whitespace...")
    idx = content.find('async function getServiceability')
    print(repr(content[idx:idx+200]))
