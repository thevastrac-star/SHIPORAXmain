const https = require('https');

// FIX #24: add 8-second timeout to prevent hanging if postalpincode.in is slow
const TIMEOUT_MS = 8000;

exports.fetchPincodeData = (pincode) => {
  return new Promise((resolve) => {
    const url = `https://api.postalpincode.in/pincode/${pincode}`;
    const req = https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const po = parsed?.[0]?.PostOffice?.[0];
          if (parsed?.[0]?.Status === 'Success' && po) {
            resolve({ success: true, city: po.District, state: po.State, country: 'India', postOffice: po.Name });
          } else {
            fetchFallback(pincode, resolve);
          }
        } catch (_) {
          fetchFallback(pincode, resolve);
        }
      });
    });

    req.setTimeout(TIMEOUT_MS, () => {
      req.destroy();
      fetchFallback(pincode, resolve);
    });

    req.on('error', () => fetchFallback(pincode, resolve));
  });
};

function fetchFallback(pincode, resolve) {
  const commonPincodes = {
    '110001': { city: 'New Delhi',  state: 'Delhi' },
    '400001': { city: 'Mumbai',     state: 'Maharashtra' },
    '700001': { city: 'Kolkata',    state: 'West Bengal' },
    '600001': { city: 'Chennai',    state: 'Tamil Nadu' },
    '560001': { city: 'Bangalore',  state: 'Karnataka' },
    '500001': { city: 'Hyderabad',  state: 'Telangana' },
    '380001': { city: 'Ahmedabad',  state: 'Gujarat' },
    '411001': { city: 'Pune',       state: 'Maharashtra' },
    '302001': { city: 'Jaipur',     state: 'Rajasthan' },
    '226001': { city: 'Lucknow',    state: 'Uttar Pradesh' }
  };
  if (commonPincodes[pincode]) {
    return resolve({ success: true, ...commonPincodes[pincode], country: 'India' });
  }
  resolve({ success: false, message: 'Pincode not found. Please enter city and state manually.' });
}
