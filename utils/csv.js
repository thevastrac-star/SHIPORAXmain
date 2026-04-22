/**
 * Convert array of objects to CSV string
 */
exports.toCSV = (data, fields) => {
  if (!data || data.length === 0) return '';
  const header = fields.join(',');
  const rows = data.map(row =>
    fields.map(f => {
      const val = f.split('.').reduce((o, k) => (o && o[k] !== undefined ? o[k] : ''), row);
      const str = String(val || '').replace(/"/g, '""');
      return `"${str}"`;
    }).join(',')
  );
  return [header, ...rows].join('\n');
};
