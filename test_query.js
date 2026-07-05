require('dotenv').config();
const axios = require('axios');
const shopifyUrl = 'https://' + process.env.SHOPIFY_STORE_DOMAIN + '/admin/api/2024-04/graphql.json';
async function run() {
  const query = {
    products(first: 20, query: \\"title:*Jog* OR title:*Duncan*\\") {
      edges {
        node {
          title
          vendor
        }
      }
    }
  };
  const res = await axios.post(shopifyUrl, { query }, { headers: { 'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN, 'Content-Type': 'application/json' } });
  console.log(JSON.stringify(res.data, null, 2));
}
run().catch(console.error);
