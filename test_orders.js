require('dotenv').config();
const axios = require('axios');
const shopifyUrl = 'https://' + process.env.SHOPIFY_STORE_DOMAIN + '/admin/api/2024-04/graphql.json';

const query = {
  orders(first: 50, query: \"updated_at:>=2026-06-01 AND updated_at:<=2026-07-31\") {
    edges {
      node {
        name
        refunds {
          createdAt
          refundLineItems(first: 10) {
            edges {
              node {
                lineItem {
                  title
                }
              }
            }
          }
        }
      }
    }
  }
};

async function run() {
  const res = await axios.post(shopifyUrl, { query }, { headers: { 'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN, 'Content-Type': 'application/json' } });
  
  const orders = res.data.data.orders.edges;
  orders.forEach(edge => {
    const order = edge.node;
    if (order.refunds && order.refunds.length > 0) {
      order.refunds.forEach(refund => {
        const d = new Date(refund.createdAt);
        if (d.getMonth() === 5) { // June is 5
          const items = refund.refundLineItems.edges;
          items.forEach(itemEdge => {
            const title = itemEdge.node.lineItem ? itemEdge.node.lineItem.title.toUpperCase() : '';
            if (title.includes('MUNDIALISTA') || title.includes('COURT') || title.includes('IRON')) {
               console.log('Order: ' + order.name + ' | Title: ' + title);
            }
          });
        }
      });
    }
  });
}
run().catch(console.error);
