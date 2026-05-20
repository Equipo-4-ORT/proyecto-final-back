const dotenv = require('dotenv');

module.exports = async () => {
  dotenv.config({ path: '.env.test', override: true });
};
