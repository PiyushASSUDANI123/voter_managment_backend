const NodeCache = require('node-cache');

// Standard Cache (TTL 5 minutes)
const cache = new NodeCache({ stdTTL: 300, checkperiod: 320 });

module.exports = cache;
