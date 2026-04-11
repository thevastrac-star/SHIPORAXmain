const https = require('https');

/**
 * Fetch city & state for an Indian pincode.
 * Primary: api.postalpincode.in
 * Fallback: api.data.gov.in pincode dataset
 */
exports.fetchPincodeData = (pincode) => {
  return new Promise((resolve) => {
    // Try primary API
    const url = `https://api.postalpincode.in/pincode/${pincode}`;
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed[0] && parsed[0].Status === 'Success' && parsed[0].PostOffice && parsed[0].PostOffice.length > 0) {
            const po = parsed[0].PostOffice[0];
            resolve({ success: true, city: po.District, state: po.State, country: 'India', postOffice: po.Name });
          } else {
            // Try fallback
            fetchFallback(pincode, resolve);
          }
        } catch (e) {
          fetchFallback(pincode, resolve);
        }
      });
    }).on('error', () => {
      fetchFallback(pincode, resolve);
    });
  });
};

function fetchFallback(pincode, resolve) {
  // Static map for common pincodes as absolute fallback
  const commonPincodes = {
    '110001': { city: 'New Delhi', state: 'Delhi' },
    '400001': { city: 'Mumbai', state: 'Maharashtra' },
    '700001': { city: 'Kolkata', state: 'West Bengal' },
    '600001': { city: 'Chennai', state: 'Tamil Nadu' },
    '560001': { city: 'Bangalore', state: 'Karnataka' },
    '500001': { city: 'Hyderabad', state: 'Telangana' },
    '380001': { city: 'Ahmedabad', state: 'Gujarat' },
    '411001': { city: 'Pune', state: 'Maharashtra' },
    '302001': { city: 'Jaipur', state: 'Rajasthan' },
    '226001': { city: 'Lucknow', state: 'Uttar Pradesh' },
  };
  if (commonPincodes[pincode]) {
    return resolve({ success: true, ...commonPincodes[pincode], country: 'India' });
  }
  resolve({ success: false, message: 'Pincode not found. Please enter city and state manually.' });
}
