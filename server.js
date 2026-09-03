import express from 'express';
import cors from 'cors';
import axios from 'axios';
import ExcelJS from 'exceljs';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.set('trust proxy', 1); // Necesario detras del proxy de Render/Railway (https)
const PORT = process.env.PORT || 3001;
const CONFIG_PATH = path.join(__dirname, 'config.json');

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Servir archivos estáticos de la aplicación React construida (producción)
app.use(express.static(path.join(__dirname, 'dist')));

// Auxiliar para formatear la URL de la tienda de Shopify
const formatStoreUrl = (url) => {
  if (!url) return '';
  let cleaned = url.trim().toLowerCase();
  cleaned = cleaned.replace(/^https?:\/\//, '');
  cleaned = cleaned.split('/')[0];
  if (!cleaned.includes('.myshopify.com')) {
    cleaned = `${cleaned}.myshopify.com`;
  }
  return cleaned;
};

// Leer credenciales de la App guardadas localmente
const readConfig = async () => {
  // En produccion, las credenciales vienen de variables de entorno (nunca del repo).
  if (process.env.SHOPIFY_CLIENT_ID && process.env.SHOPIFY_CLIENT_SECRET) {
    return {
      clientId: process.env.SHOPIFY_CLIENT_ID,
      clientSecret: process.env.SHOPIFY_CLIENT_SECRET,
    };
  }
  // En desarrollo local, se lee del archivo config.json.
  try {
    const data = await fs.readFile(CONFIG_PATH, 'utf8');
    return JSON.parse(data);
  } catch (e) {
    return { clientId: '', clientSecret: '' };
  }
};

// Guardar credenciales de la App localmente
const writeConfig = async (config) => {
  await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
};

// Endpoint para guardar configuración del Dev Dashboard
app.post('/api/save-app-config', async (req, res) => {
  const { clientId, clientSecret } = req.body;
  if (!clientId || !clientSecret) {
    return res.status(400).json({ success: false, error: 'Faltan parámetros requeridos.' });
  }

  try {
    await writeConfig({ clientId, clientSecret });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Endpoint para obtener la configuración guardada (sin el Client Secret completo por seguridad)
app.get('/api/get-app-config', async (req, res) => {
  const config = await readConfig();
  res.json({
    clientId: config.clientId,
    hasSecret: !!config.clientSecret,
  });
});

// 1. OAUTH: Iniciar redirección de autenticación
app.get('/api/auth', async (req, res) => {
  const { shop } = req.query;
  if (!shop) {
    return res.status(400).send('Falta el parámetro "shop".');
  }

  const cleanShop = formatStoreUrl(shop);
  const config = await readConfig();

  if (!config.clientId) {
    return res.status(400).send('La aplicación no está configurada con Client ID en el servidor. Por favor configúrala primero.');
  }

  const scopes = 'read_orders,read_products,read_inventory,read_returns,read_order_edits,read_locations';
  const appUrl = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
  const redirectUri = `${appUrl}/api/auth/callback`;

  // Redirigir al usuario al login de Shopify para autorizar
  const authorizeUrl = `https://${cleanShop}/admin/oauth/authorize?client_id=${config.clientId}&scope=${scopes}&redirect_uri=${encodeURIComponent(redirectUri)}`;
  res.redirect(authorizeUrl);
});

// 2. OAUTH: Callback para intercambiar código temporal por token permanente
app.get('/api/auth/callback', async (req, res) => {
  const { code, shop } = req.query;
  if (!code || !shop) {
    return res.status(400).send('Faltan parámetros de autorización en el retorno de Shopify.');
  }

  const cleanShop = formatStoreUrl(shop);
  const config = await readConfig();

  try {
    // Petición POST para intercambiar el code por el access_token permanente
    const tokenResponse = await axios.post(`https://${cleanShop}/admin/oauth/access_token`, {
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code
    });

    const accessToken = tokenResponse.data.access_token;
    if (!accessToken) {
      return res.status(400).send('No se recibió el token de acceso de Shopify.');
    }

    // Redirigir de vuelta al panel de React, pasando el shop y el token en la URL
    res.redirect(`/?shop=${cleanShop}&token=${accessToken}`);
  } catch (error) {
    console.error('Error al realizar el intercambio de token OAuth:', error.message);
    res.status(500).send(`Error de autenticación con Shopify: ${error.response?.data?.error_description || error.message}`);
  }
});

// 3. Endpoint para verificar conexión activa (se usa con el token guardado)
app.post('/api/verify-connection', async (req, res) => {
  const { storeUrl, accessToken } = req.body;
  const shopifyHost = formatStoreUrl(storeUrl);

  if (!shopifyHost || !accessToken) {
    return res.status(400).json({ success: false, error: 'La URL de la tienda y el token de acceso son requeridos.' });
  }

  try {
    const query = `
      query {
        shop {
          name
          myshopifyDomain
          currencyCode
        }
      }
    `;

    const response = await axios.post(
      `https://${shopifyHost}/admin/api/2024-04/graphql.json`,
      { query },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': accessToken,
        },
      }
    );

    if (response.data.errors) {
      return res.status(400).json({
        success: false,
        error: response.data.errors.map((e) => e.message).join(', '),
      });
    }

    const shop = response.data?.data?.shop;
    if (!shop) {
      return res.status(400).json({ success: false, error: 'No se pudo obtener la información de la tienda.' });
    }

    // Consultar sucursales por separado para no bloquear la verificación si falta alcance (scope)
    let locations = [];
    try {
      const locQuery = `
        query {
          locations(first: 50) {
            edges {
              node {
                name
              }
            }
          }
        }
      `;
      const locResponse = await axios.post(
        `https://${shopifyHost}/admin/api/2024-04/graphql.json`,
        { query: locQuery },
        {
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Access-Token': accessToken,
          },
        }
      );
      if (locResponse.data?.data?.locations?.edges) {
        locations = locResponse.data.data.locations.edges.map(e => e.node.name);
      }
    } catch (locError) {
      console.error('Error al obtener sucursales:', locError.message);
    }

    res.json({
      success: true,
      shopName: shop.name,
      domain: shop.myshopifyDomain,
      currency: shop.currencyCode,
      locations,
    });
  } catch (error) {
    console.error('Error al verificar conexión:', error.message);
    res.status(500).json({
      success: false,
      error: `Error de conexión: ${error.response?.data?.errors || error.message}`,
    });
  }
});

// Version del codigo en ejecucion y ultimo diagnostico, para poder verificar que el servidor
// desplegado sea el que corresponde sin tener que entrar a los logs del hosting.
const VERSION_APP = '2026-09-03-a';
// CRITERIO DE LIQUIDACION VIGENTE: FECHA DE PAGO del pedido. Si el cliente pago dentro del
// periodo, el proveedor cobra todo lo que quedo en el pedido, este despachado o no. No hay
// fecha de corte: cada pedido se paga una sola vez, en el mes en que entro la plata.
// Pedidos a trazar en detalle en el diagnostico, para investigar casos puntuales.
const PEDIDOS_A_VIGILAR = (process.env.PEDIDOS_A_VIGILAR || '#207050').split(',').map((x) => x.trim()).filter(Boolean);
let ultimoDiagnostico = { generado: null, resumen: 'Todavia no se genero ninguna liquidacion en este servidor.' };

app.get('/api/version', (req, res) => {
  res.json({ version: VERSION_APP, diagnostico: ultimoDiagnostico });
});

// 4. Endpoint para obtener pedidos y calcular pre-liquidaciones (Soporta Devoluciones y Descuentos)
app.post('/api/fetch-settlements', async (req, res) => {
  const { storeUrl, accessToken, startDate, endDate, financialStatus, fulfillmentStatus, brandDiscounts = {} } = req.body;
  const shopifyHost = formatStoreUrl(storeUrl);

  if (!shopifyHost || !accessToken || !startDate || !endDate) {
    return res.status(400).json({ success: false, error: 'Faltan parámetros requeridos.' });
  }

  try {
    // El corte del mes se hace en hora de Argentina, no en UTC: sin esto, una venta del 31/8
    // a las 22:00 (01:00 UTC del 1/9) se escapaba del período.
    const TZ_OFFSET = '-03:00';

    // Los límites se mandan a Shopify en UTC puro (terminados en Z). Antes se mandaban con el
    // desfasaje "-03:00" adentro de la búsqueda y el buscador de Shopify no lo interpretaba
    // bien: se quedaban afuera pedidos que sí correspondían al mes (por ejemplo el #207050).
    const inicioUTC = new Date(`${startDate}T00:00:00${TZ_OFFSET}`).toISOString();

    // Un solo criterio, sin paréntesis ni OR: todo pedido que tenga algo que ver con el mes
    // (creado, despachado, devuelto o editado) quedó actualizado a partir del inicio del período.
    // El recorte fino por fecha de despacho se hace más abajo, en código.
    let queryFilters = `updated_at:>=${inicioUTC}`;

    if (financialStatus && financialStatus !== 'any') {
      queryFilters += ` AND financial_status:${financialStatus}`;
    }
    if (fulfillmentStatus && fulfillmentStatus !== 'any') {
      queryFilters += ` AND fulfillment_status:${fulfillmentStatus}`;
    }

    let hasNextPage = true;
    let cursor = null;
    let allOrders = [];
    let incluirTransacciones = true;
    let avisoTransacciones = null;

    console.log(`Buscando pedidos por updated_at con filtro: ${queryFilters}`);

    while (hasNextPage) {
      // Las transacciones dan la FECHA DE PAGO real (la que muestra Shopify como "Paid at"),
      // que no siempre coincide con processedAt: un pedido puede crearse un dia y pagarse otro.
      // Si la tienda no expone este campo, se reintenta sin el y se usa processedAt.
      const bloqueTransacciones = incluirTransacciones
        ? `
                transactions(first: 20) {
                  id
                  kind
                  status
                  processedAt
                }`
        : '';

      const graphqlQuery = `
        query getOrders($first: Int!, $after: String, $queryStr: String!) {
          orders(first: $first, after: $after, query: $queryStr) {
            pageInfo {
              hasNextPage
              endCursor
            }
            edges {
              node {
                id
                name
                createdAt
                processedAt
                cancelledAt
                displayFinancialStatus
                returnStatus${bloqueTransacciones}
                displayFulfillmentStatus
                retailLocation {
                  name
                }
                fulfillments(first: 50) {
                  id
                  createdAt
                  status
                  location {
                    name
                  }
                  fulfillmentLineItems(first: 100) {
                    edges {
                      node {
                        lineItem {
                          id
                          title
                          vendor
                          variantTitle
                          sku
                          originalUnitPriceSet {
                            shopMoney {
                              amount
                            }
                          }
                          variant {
                            id
                            sku
                            price
                            inventoryItem {
                              id
                              unitCost {
                                amount
                              }
                            }
                          }
                        }
                        quantity
                      }
                    }
                  }
                }
                totalPriceSet {
                  shopMoney {
                    amount
                    currencyCode
                  }
                }
                lineItems(first: 100) {
                  edges {
                    node {
                      id
                      title
                      quantity
                      currentQuantity
                      unfulfilledQuantity
                      vendor
                      variantTitle
                      sku
                      originalUnitPriceSet {
                        shopMoney {
                          amount
                          currencyCode
                        }
                      }
                      variant {
                        id
                        sku
                        price
                        inventoryItem {
                          id
                          unitCost {
                            amount
                            currencyCode
                          }
                        }
                      }
                    }
                  }
                }
                refunds {
                  id
                  createdAt
                  refundLineItems(first: 50) {
                    edges {
                      node {
                        quantity
                        restockType
                        location {
                          name
                        }
                        lineItem {
                          id
                          title
                          vendor
                          sku
                          variantTitle
                          originalUnitPriceSet {
                            shopMoney {
                              amount
                            }
                          }
                          variant {
                            id
                            sku
                            price
                            inventoryItem {
                              id
                              unitCost {
                                amount
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      `;

      const variables = {
        first: 50,
        after: cursor,
        queryStr: queryFilters,
      };

      const response = await axios.post(
        `https://${shopifyHost}/admin/api/2024-04/graphql.json`,
        { query: graphqlQuery, variables },
        {
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Access-Token': accessToken,
          },
        }
      );

      if (response.data.errors) {
        const mensaje = response.data.errors.map((e) => e.message).join(', ');
        // Si la version de la API no acepta el bloque de transacciones, se reintenta la misma
        // pagina sin el en vez de romper toda la liquidacion.
        if (incluirTransacciones && /transaction/i.test(mensaje)) {
          incluirTransacciones = false;
          avisoTransacciones = `No se pudieron leer las transacciones (${mensaje}). Se usa la fecha de procesamiento del pedido como fecha de pago.`;
          continue;
        }
        throw new Error(mensaje);
      }

      const ordersData = response.data?.data?.orders;
      const edges = ordersData?.edges || [];
      allOrders.push(...edges.map((edge) => edge.node));

      hasNextPage = ordersData?.pageInfo?.hasNextPage || false;
      cursor = ordersData?.pageInfo?.endCursor || null;
    }

    const startDateTime = new Date(`${startDate}T00:00:00${TZ_OFFSET}`).getTime();
    const endDateTime = new Date(`${endDate}T23:59:59${TZ_OFFSET}`).getTime();

    const vendorAggregates = {};
    const missingCosts = [];
    // Devoluciones que todavía no se descuentan porque el cambio no se cerró.
    const devolucionesEnCurso = [];
    // Devoluciones que se descuentan aunque Shopify no haya repuesto el articulo al stock.
    const devolucionesSinReposicion = [];
    // Traza completa de los pedidos vigilados: todo lo que la app ve de ellos.
    const pedidosVigilados = [];
    // Notas de credito que no se descuentan porque su reemplazo tampoco se liquida.
    const notasDeCreditoOmitidas = [];
    // Articulos que se liquidan pero todavia no salieron del deposito. Se pagan igual (criterio
    // de fecha de pago), pero conviene tenerlos a la vista.
    const articulosSinDespachar = [];
    // Pedidos creados ANTES del periodo pero pagados dentro. Con el criterio viejo (fecha del
    // pedido) pueden haberse liquidado el mes pasado: hay que mirarlos para no pagar dos veces.
    const pedidosCreadosAntesPeroPagadosEnElPeriodo = [];

    // ============================================================================
    // FECHA DE PAGO: es el criterio de liquidacion. Se toma el primer cobro exitoso del
    // pedido (lo que Shopify muestra como "Paid at"); si no hay transacciones disponibles,
    // se cae a processedAt. Se usa el PRIMER cobro y no el ultimo para que un pedido pagado
    // en cuotas no se liquide dos veces en meses distintos.
    // ============================================================================
    const fechaDePago = (order) => {
      const cobros = (order.transactions || [])
        .filter((t) => ['SALE', 'CAPTURE'].includes(String(t.kind || '').toUpperCase()))
        .filter((t) => String(t.status || '').toUpperCase() === 'SUCCESS')
        .map((t) => new Date(t.processedAt).getTime())
        .filter((t) => !isNaN(t))
        .sort((a, b) => a - b);
      if (cobros.length) return cobros[0];
      const p = new Date(order.processedAt).getTime();
      return isNaN(p) ? null : p;
    };

    const registerItemRecord = (brand, item, quantity, date, orderName, type, hasCostInShopify, unitCostShopify, salePrice, paymentStatus, location) => {
      
      let unitCostOriginal = 0;
      let unitCost = 0;
      let discountPercent = 0;
      
      // La regla matemática es SOLO para la marca Familyarg (o variaciones)
      if (brand.toLowerCase().includes('familyarg')) {
        // 1. Costo Original = PVP / 2
        unitCostOriginal = salePrice / 2;
        
        // 2. Descuento a retener (por defecto 15% o el que venga configurado de la UI)
        discountPercent = (brandDiscounts[brand] !== undefined && brandDiscounts[brand] !== '') 
            ? parseFloat(brandDiscounts[brand]) 
            : 15;
        
        // 3. Costo Neto a liquidar = Costo Original menos el % de descuento
        unitCost = unitCostOriginal * (1 - (discountPercent / 100));

        // Forzamos a true para que no salga en "costos faltantes"
        hasCostInShopify = true;
      } else {
        // Para otras marcas, toma el costo original directo desde Shopify
        unitCost = hasCostInShopify ? unitCostShopify : 0;
        unitCostOriginal = unitCost;
        
        // Aplica un descuento básico si está configurado en la UI
        discountPercent = parseFloat(brandDiscounts[brand]) || 0;
        if (discountPercent > 0 && discountPercent < 100) {
           unitCostOriginal = unitCost / (1 - (discountPercent / 100));
        }
      }

      const totalSale = salePrice * quantity;
      const totalCost = unitCost * quantity; 
      const totalCostOriginal = unitCostOriginal * quantity; 

      // Ignorar transacciones que den cero en venta y costo (no tienen movimiento financiero)
      if (Math.abs(totalSale) < 0.01 && Math.abs(totalCost) < 0.01) {
        return;
      }

      if (!hasCostInShopify && quantity > 0) {
        const sku = item.sku || 'SIN_SKU';
        const alreadyInMissing = missingCosts.find(m => m.sku === sku);
        if (!alreadyInMissing) {
          missingCosts.push({
            sku,
            title: item.title,
            variantTitle: item.variantTitle || '',
            vendor: brand,
            shopifyPrice: parseFloat(item.variant?.price || salePrice),
          });
        }
      }

      if (!vendorAggregates[brand]) {
        vendorAggregates[brand] = {
          brandName: brand,
          totalQuantity: 0,
          totalSales: 0,
          totalCost: 0,
          totalCostOriginal: 0,
          items: [],
        };
      }

      vendorAggregates[brand].totalQuantity += quantity;
      vendorAggregates[brand].totalSales += totalSale;
      vendorAggregates[brand].totalCost += totalCost;
      vendorAggregates[brand].totalCostOriginal += totalCostOriginal;

      vendorAggregates[brand].items.push({
        orderName,
        date,
        type, 
        sku: item.sku || 'SIN_SKU',
        title: item.title,
        variantTitle: item.variantTitle || '',
        quantity,
        salePrice,
        totalSale,
        unitCost,
        totalCost,
        unitCostOriginal,
        totalCostOriginal,
        discountPercent,
        hasCostInShopify,
        paymentStatus: paymentStatus || 'paid',
        salesChannel: 'Online Store',
        location: location || 'Sin Ubicación',
      });
    };

    // Excepciones de marcas que deben conservar una capitalización específica
    // (ej. siglas). Clave en minúsculas -> nombre a mostrar.
    const brandCasingExceptions = {
      // 'dc': 'DC',
      // 'h&m': 'H&M',
    };

    // Convierte a Title Case de forma ESTABLE: "gotcha" y "Gotcha" -> "Gotcha".
    // Esto garantiza que una misma marca escrita con distintas may/minúsculas
    // se agrupe en un solo proveedor (una sola hoja Liq/Agr).
    const toTitleCase = (str) =>
      str
        .split(' ')
        .map((w) => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w))
        .join(' ');

    const normalizeBrand = (vendor, title = '') => {
      // Normalizar espacios en blanco y quitar espacios extra
      let b = (vendor?.trim() || 'Sin Marca').replace(/\s+/g, ' ');
      let t = title?.toUpperCase() || '';

      if (t.includes('X BRAND & CO') || t.includes('X BRAND&CO') || t.includes('X BRAND')) {
        return 'FAMILYARG x Brand & Co';
      }

      if (b.toUpperCase().includes('FAMILYARG')) {
        return 'FAMILYARG';
      }

      // Unificar variantes por may/minúsculas (ej: "gotcha" == "Gotcha")
      const key = b.toLowerCase();
      if (brandCasingExceptions[key]) {
        return brandCasingExceptions[key];
      }
      return toTitleCase(b);
    };

    allOrders.forEach((order) => {
      if (PEDIDOS_A_VIGILAR.includes(order.name)) {
        pedidosVigilados.push({
          orderName: order.name,
          creado: order.createdAt,
          procesado: order.processedAt,
          cancelado: order.cancelledAt,
          estadoPago: order.displayFinancialStatus,
          estadoPreparacion: order.displayFulfillmentStatus,
          estadoDevolucion: order.returnStatus,
          sucursalDelPedido: order.retailLocation?.name || null,
          articulos: (order.lineItems?.edges || []).map((e) => ({
            id: e.node.id, sku: e.node.sku, titulo: e.node.title, vendor: e.node.vendor,
            cantidad: e.node.quantity, actual: e.node.currentQuantity, sinDespachar: e.node.unfulfilledQuantity,
          })),
          despachos: (order.fulfillments || []).map((f) => ({
            id: f.id, fecha: f.createdAt, estado: f.status, sucursal: f.location?.name || null,
            lineas: (f.fulfillmentLineItems?.edges || []).map((e) => ({
              lineItemId: e.node.lineItem?.id || null, sku: e.node.lineItem?.sku || null,
              titulo: e.node.lineItem?.title || null, cantidad: e.node.quantity,
            })),
          })),
          reembolsos: (order.refunds || []).map((r) => ({
            id: r.id, fecha: r.createdAt,
            lineas: (r.refundLineItems?.edges || []).map((e) => ({
              sku: e.node.lineItem?.sku || null, cantidad: e.node.quantity, restockType: e.node.restockType,
            })),
          })),
        });
      }

      // Ignorar pedidos cancelados completamente para evitar deducciones incorrectas
      if (order.cancelledAt) {
        return;
      }

      // 1. Obtener la ubicación predeterminada de la orden (para ventas físicas de POS)
      const orderLoc = order.retailLocation?.name || null;

      // 2. Mapear artículo de línea -> sucursal según fulfillments, y registrar cuáles fueron preparados
      const itemLocationMap = {};
      const fulfilledItemMap = {};
      if (order.fulfillments) {
        order.fulfillments.forEach((f) => {
          const locName = f.location?.name;
          if (locName) {
            const fItems = f.fulfillmentLineItems?.edges || [];
            fItems.forEach((fEdge) => {
              const li = fEdge.node.lineItem;
              if (li) {
                itemLocationMap[li.id] = locName;
                fulfilledItemMap[li.id] = true;
              }
            });
          }
        });
      }

      // 2b. Mapear artículo de línea -> sucursal según devoluciones (restock location)
      if (order.refunds) {
        order.refunds.forEach((r) => {
          const rItems = r.refundLineItems?.edges || [];
          rItems.forEach((rEdge) => {
            const rItem = rEdge.node;
            const locName = rItem.location?.name;
            const li = rItem.lineItem;
            if (locName && li) {
              itemLocationMap[li.id] = locName;
            }
          });
        });
      }

      // 2c. Mapear artículo de línea -> cantidad actual activa (para identificar eliminados)
      const itemCurrentQuantityMap = {};
      const lineItemsList = order.lineItems?.edges || [];
      lineItemsList.forEach((edge) => {
        const item = edge.node;
        itemCurrentQuantityMap[item.id] = item.currentQuantity !== undefined ? item.currentQuantity : item.quantity;
      });

      // ============================================================================
      // VENTAS: se liquidan por FECHA DE PAGO del pedido.
      // Si el cliente pago dentro del periodo, el proveedor cobra todo lo que quedo en el
      // pedido, este despachado o no. No hay corte ni fechas de despacho: cada pedido se
      // paga una sola vez, en el mes en que entro la plata.
      // ============================================================================

      const pagoTs = fechaDePago(order);
      const pagadoEnElPeriodo = pagoTs !== null && pagoTs >= startDateTime && pagoTs <= endDateTime;
      const pagadoAntesDelPeriodo = pagoTs !== null && pagoTs < startDateTime;

      const extractCost = (item) => {
        if (item.variant?.inventoryItem?.unitCost?.amount) {
          return { unitCost: parseFloat(item.variant.inventoryItem.unitCost.amount), hasCostInShopify: true };
        }
        return { unitCost: 0, hasCostInShopify: false };
      };

      if (pagadoEnElPeriodo) {
        // Aviso: pedido de un mes anterior cobrado recien ahora. Con el criterio viejo (fecha
        // del pedido) pudo haberse liquidado antes, asi que se informa para revisarlo.
        const creadoTs = new Date(order.createdAt).getTime();
        if (!isNaN(creadoTs) && creadoTs < startDateTime) {
          pedidosCreadosAntesPeroPagadosEnElPeriodo.push({
            orderName: order.name,
            creado: order.createdAt,
            pagado: new Date(pagoTs).toISOString(),
          });
        }

        // Ubicacion informativa: la del despacho si el articulo ya salio; si no, la del pedido.
        const ubicacionPorItem = {};
        (order.fulfillments || []).forEach((f) => {
          const estado = (f.status || '').toUpperCase();
          if (['CANCELLED', 'CANCELED', 'ERROR', 'FAILURE'].includes(estado)) return;
          (f.fulfillmentLineItems?.edges || []).forEach((fEdge) => {
            const id = fEdge.node.lineItem?.id;
            if (id && !ubicacionPorItem[id]) ubicacionPorItem[id] = f.location?.name || null;
          });
        });

        lineItemsList.forEach((edge) => {
          const item = edge.node;

          // currentQuantity refleja lo que quedo en el pedido: un articulo eliminado en una
          // edicion queda en 0 y no se liquida.
          const cantidad = item.currentQuantity ?? item.quantity ?? 0;
          if (cantidad <= 0) return;
          if (!item.title && !item.sku) return;

          const brand = normalizeBrand(item.vendor, item.title);
          const salePrice = parseFloat(item.originalUnitPriceSet?.shopMoney?.amount || 0);
          const { unitCost, hasCostInShopify } = extractCost(item);
          const despachadoDesde = ubicacionPorItem[item.id];
          const ubicacion = despachadoDesde || orderLoc || 'Sin Despachar';

          if (!despachadoDesde && !orderLoc) {
            articulosSinDespachar.push({
              orderName: order.name,
              sku: item.sku || 'SIN_SKU',
              title: item.title,
              variantTitle: item.variantTitle || '',
              quantity: cantidad,
              marca: brand,
              pagado: new Date(pagoTs).toISOString(),
            });
          }

          registerItemRecord(
            brand,
            item,
            cantidad,
            new Date(pagoTs).toISOString(),
            order.name,
            'Venta',
            hasCostInShopify,
            unitCost,
            salePrice,
            order.displayFinancialStatus,
            ubicacion
          );
        });
      }

      // Para un pedido PAGADO EN UN MES ANTERIOR, un despacho dentro de este periodo significa
      // que salio un articulo de cambio: ese reemplazo no se liquida (la venta ya se cobro en su
      // mes) y por lo tanto la nota de credito de lo devuelto tampoco corresponde. Se guarda por
      // MARCA para no tapar la nota de un proveedor con el reemplazo de otro (caso #206107).
      const marcasConReemplazoEnElPeriodo = new Set();
      if (pagadoAntesDelPeriodo) {
        const porId = {};
        lineItemsList.forEach((edge) => { porId[edge.node.id] = edge.node; });
        (order.fulfillments || []).forEach((f) => {
          const t = new Date(f.createdAt).getTime();
          if (isNaN(t) || t < startDateTime || t > endDateTime) return;
          if (['CANCELLED', 'CANCELED', 'ERROR', 'FAILURE'].includes((f.status || '').toUpperCase())) return;
          (f.fulfillmentLineItems?.edges || []).forEach((fEdge) => {
            const ref = fEdge.node.lineItem;
            const resuelto = porId[ref?.id] || ref;
            if (!resuelto || !(resuelto.title || resuelto.sku)) return;
            marcasConReemplazoEnElPeriodo.add(normalizeBrand(resuelto.vendor, resuelto.title));
          });
        });
      }

      const refunds = order.refunds || [];

      refunds.forEach((refund) => {
        const refundTime = new Date(refund.createdAt).getTime();
        if (refundTime >= startDateTime && refundTime <= endDateTime) {
          const refundLineItems = refund.refundLineItems?.edges || [];
          
          refundLineItems.forEach((edge) => {
            const refundItem = edge.node;
            const item = refundItem.lineItem;
            if (!item) return;

            // NO contar cancelaciones por edicion de orden (ej. cambio de talle antes de despachar):
            // no son devoluciones reales, el proveedor conserva la venta del articulo que si se despacho.
            if (refundItem.restockType === 'CANCEL') return;

            // Una devolución se descuenta recién cuando el cambio se cerró. Mientras la
            // devolución está EN CURSO —el cliente la pidió pero todavía no se resolvió— la
            // venta se mantiene como venta normal y la nota de crédito espera al mes en que
            // se cierre.
            //
            // Importante: NO se mira si Shopify repuso el artículo al stock. En esta operación
            // nunca se le devuelve la plata al cliente antes de recibir la prenda, así que un
            // reembolso hecho significa que la mercadería volvió, se haya repuesto al inventario
            // o no (por ejemplo si volvió fallada).
            // Pedido pagado en un mes anterior que ademas saco un reemplazo en este periodo: la
            // venta original ya se cobro en su mes y el reemplazo no se vuelve a cobrar, asi que
            // la nota de credito tampoco corresponde. Van las dos juntas o ninguna. (Caso #205479:
            // buzo devuelto por falla y repuesto por otro igual.) Si el pedido viejo NO saco nada
            // en el periodo, fue una devolucion sin reemplazo y la nota SI se descuenta.
            //
            // El reemplazo tiene que ser DE LA MISMA MARCA que lo devuelto. Si el pedido viejo
            // despachó en el período algo de otra marca, para este proveedor fue una devolución
            // sin reemplazo y la nota SÍ se descuenta.
            const marcaDevuelta = normalizeBrand(item.vendor, item.title);
            if (pagadoAntesDelPeriodo && marcasConReemplazoEnElPeriodo.has(marcaDevuelta)) {
              notasDeCreditoOmitidas.push({
                orderName: order.name,
                sku: item.sku || 'SIN_SKU',
                title: item.title,
                variantTitle: item.variantTitle || '',
                marca: marcaDevuelta,
                quantity: refundItem.quantity,
                motivo: 'Pedido pagado en un mes anterior con reemplazo de la misma marca: el reemplazo no se liquida, la nota tampoco',
              });
              return;
            }

            const returnEnCurso = ['RETURN_REQUESTED', 'IN_PROGRESS', 'RETURN_FAILED'].includes(order.returnStatus);
            if (returnEnCurso) {
              devolucionesEnCurso.push({
                orderName: order.name,
                sku: item.sku || 'SIN_SKU',
                title: item.title,
                variantTitle: item.variantTitle || '',
                quantity: refundItem.quantity,
                motivo: `Devolución en curso (${order.returnStatus})`,
              });
              return;
            }

            if (refundItem.restockType === 'NO_RESTOCK') {
              devolucionesSinReposicion.push({
                orderName: order.name,
                sku: item.sku || 'SIN_SKU',
                title: item.title,
                variantTitle: item.variantTitle || '',
                quantity: refundItem.quantity,
                nota: 'Se descuenta igual: hubo reembolso, pero Shopify no repuso el articulo al stock',
              });
            }

            // Omitir reembolsos de artículos unfulfilled (no preparados) y que fueron eliminados (currentQuantity = 0)
            const isFulfilledOrPOS = !!fulfilledItemMap[item.id] || !!orderLoc;
            const currentQty = itemCurrentQuantityMap[item.id];
            if (!isFulfilledOrPOS && currentQty === 0) {
              return;
            }

            const brand = normalizeBrand(item.vendor, item.title);
            const quantity = -refundItem.quantity;
            const salePrice = parseFloat(item.originalUnitPriceSet?.shopMoney?.amount || 0);

            let unitCost = 0;
            let hasCostInShopify = false;
            if (item.variant?.inventoryItem?.unitCost?.amount) {
              unitCost = parseFloat(item.variant.inventoryItem.unitCost.amount);
              hasCostInShopify = true;
            }

            // Ubicación del reembolso: usar restock location si existe, sino sucursal de preparación, sino POS, sino 'Sin Ubicación'
            const refundLoc = refundItem.location?.name || itemLocationMap[item.id] || orderLoc || 'Sin Ubicación';

            registerItemRecord(brand, item, quantity, refund.createdAt, `${order.name}`, 'Devolución', hasCostInShopify, unitCost, salePrice, order.displayFinancialStatus, refundLoc);
          });
        }
      });

      // NOTA: acá había un bloque que registraba cancelaciones. Era código muerto: los pedidos
      // cancelados salen por el `return` del principio de este forEach y nunca llegaban hasta acá.
    });

    const summary = Object.values(vendorAggregates).map((v) => {
      const margin = v.totalSales - v.totalCost;
      const marginPercent = v.totalSales > 0 ? (margin / v.totalSales) * 100 : 0;
      return {
        brandName: v.brandName,
        totalQuantity: v.totalQuantity,
        totalSales: v.totalSales,
        totalCost: v.totalCost, 
        totalCostOriginal: v.totalCostOriginal, 
        margin,
        marginPercent,
        itemsCount: v.items.length,
      };
    });

    ultimoDiagnostico = {
      generado: new Date().toISOString(),
      periodo: `${startDate} a ${endDate}`,
      criterio: 'FECHA DE PAGO',
      avisoTransacciones,
      pedidosTraidos: allOrders.length,
      articulosSinDespachar,
      pedidosCreadosAntesPeroPagadosEnElPeriodo,
      notasDeCreditoOmitidas,
      devolucionesSinReposicion,
      pedidosVigilados,
      devolucionesEnCurso,
    };

    if (avisoTransacciones) {
      console.log('=== AVISO ===');
      console.log(avisoTransacciones);
    }
    if (articulosSinDespachar.length) {
      console.log('=== ARTICULOS LIQUIDADOS QUE TODAVIA NO SE DESPACHARON ===');
      console.log(articulosSinDespachar.map((a) => `${a.orderName} ${a.sku} x${a.quantity} (${a.marca})`).join('\n'));
    }
    if (devolucionesEnCurso.length) {
      console.log('=== DEVOLUCIONES EN CURSO (no se descontaron) ===');
      console.log(devolucionesEnCurso.map((d) => `${d.orderName} ${d.sku} x${d.quantity} - ${d.motivo}`).join('\n'));
    }

    res.json({
      success: true,
      ordersCount: allOrders.length,
      summary,
      details: vendorAggregates,
      missingCosts,
      criterio: 'FECHA DE PAGO',
      avisoTransacciones,
      devolucionesEnCurso,
      devolucionesSinReposicion,
      notasDeCreditoOmitidas,
      pedidosVigilados,
      articulosSinDespachar,
      pedidosCreadosAntesPeroPagadosEnElPeriodo,
    });
  } catch (error) {
    console.error('Error al procesar liquidaciones:', error.message);
    res.status(500).json({
      success: false,
      error: `Error al procesar pedidos: ${error.message}`,
    });
  }
});

// 5. Endpoint para exportar a Excel
app.post('/api/export-excel', async (req, res) => {
  const { summary, details, period } = req.body;

  try {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Marketplace Liquidaciones App';
    workbook.created = new Date();

    const headerFill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF1E293B' },
    };

    const headerFont = {
      name: 'Segoe UI',
      size: 11,
      bold: true,
      color: { argb: 'FFFFFFFF' },
    };

    const borderStyle = {
      top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
      left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
      bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } },
      right: { style: 'thin', color: { argb: 'FFCBD5E1' } },
    };

    const doubleBottomBorder = {
      top: { style: 'thin', color: { argb: 'FF94A3B8' } },
      bottom: { style: 'double', color: { argb: 'FF1E293B' } },
    };

    // HOJA 1: RESUMEN GENERAL
    const summarySheet = workbook.addWorksheet('Resumen General');
    summarySheet.views = [{ showGridLines: true }];

    // Regla del 3% por transferencia: la misma que se aplica en las hojas "Agr -".
    // x Brand & Co no lo lleva (arreglo con Wanda: no durante sus primeros meses).
    const llevaDescuentoTransferencia = (nombreMarca) => {
      const m = (nombreMarca || '').toUpperCase();
      return !(m.includes('BRAND & CO') || m.includes('BRAND&CO'));
    };

    summarySheet.mergeCells('A1:I1');
    const titleCell = summarySheet.getCell('A1');
    titleCell.value = 'RESUMEN GENERAL DE LIQUIDACIONES';
    titleCell.font = { name: 'Segoe UI', size: 16, bold: true, color: { argb: 'FF0F172A' } };
    titleCell.alignment = { vertical: 'middle', horizontal: 'left' };
    summarySheet.getRow(1).height = 40;

    summarySheet.mergeCells('A2:I2');
    const periodCell = summarySheet.getCell('A2');
    periodCell.value = `Periodo consultado: ${period || 'N/A'}`;
    periodCell.font = { name: 'Segoe UI', size: 10, italic: true, color: { argb: 'FF475569' } };
    summarySheet.getRow(2).height = 20;

    summarySheet.getRow(3).height = 10;

    const summaryHeaders = [
      'Marca / Proveedor',
      'Cantidad pedida',
      'Ventas netas',
      'Costo de los bienes vendidos (Original)',
      'Costo de los bienes vendidos (Neto)',
      'IVA 21%',
      'TOTAL',
      'DTO. 3% PAGO POR TRANSF.',
      'TOTAL A TRANSFERIR',
    ];
    summarySheet.getRow(4).values = summaryHeaders;
    summarySheet.getRow(4).height = 28;

    for (let col = 1; col <= 9; col++) {
      const cell = summarySheet.getCell(4, col);
      cell.fill = headerFill;
      cell.font = headerFont;
      cell.alignment = { vertical: 'middle', horizontal: col === 1 ? 'left' : 'right' };
      cell.border = borderStyle;
    }

    // El resumen ahora cierra la cuenta de cada marca igual que su hoja "Agr -":
    // costo neto -> IVA -> TOTAL -> descuento por transferencia -> TOTAL A TRANSFERIR.
    // Los importes se escriben como NUMEROS, no como formulas: Excel no calcula formulas
    // mientras el archivo esta en "Vista protegida" y la fila de totales aparecia vacia.
    const FILL_TRANSFERIR = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDE047' } };
    const FILL_DESCUENTO = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF5EEAD4' } };

    let startRow = 5;
    const acumulado = { cantidad: 0, ventas: 0, original: 0, neto: 0, iva: 0, total: 0, descuento: 0, aTransferir: 0 };

    summary.forEach((row, index) => {
      const currentRowNum = startRow + index;

      const neto = row.totalCost || 0;
      const iva = neto * 0.21;
      const total = neto + iva;
      const descuento = llevaDescuentoTransferencia(row.brandName) ? total * -0.03 : 0;
      const aTransferir = total + descuento;

      acumulado.cantidad += row.totalQuantity || 0;
      acumulado.ventas += row.totalSales || 0;
      acumulado.original += row.totalCostOriginal || 0;
      acumulado.neto += neto;
      acumulado.iva += iva;
      acumulado.total += total;
      acumulado.descuento += descuento;
      acumulado.aTransferir += aTransferir;

      summarySheet.getRow(currentRowNum).values = [
        row.brandName,
        row.totalQuantity,
        row.totalSales,
        row.totalCostOriginal,
        neto,
        iva,
        total,
        descuento,
        aTransferir,
      ];
      summarySheet.getRow(currentRowNum).height = 22;

      for (let col = 1; col <= 9; col++) {
        const cell = summarySheet.getCell(currentRowNum, col);
        cell.font = { name: 'Segoe UI', size: 10, bold: col === 9 };
        cell.border = borderStyle;

        if (col === 9) {
          cell.fill = FILL_TRANSFERIR;
        } else if (col === 8) {
          cell.fill = FILL_DESCUENTO;
        } else if (currentRowNum % 2 === 0) {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
        }

        if (col === 1) {
          cell.alignment = { vertical: 'middle', horizontal: 'left' };
        } else if (col === 2) {
          cell.alignment = { vertical: 'middle', horizontal: 'right' };
          cell.numFormat = '#,##0';
        } else {
          cell.alignment = { vertical: 'middle', horizontal: 'right' };
          cell.numFormat = '$#,##0.00';
        }
      }
    });

    const totalRowNum = startRow + summary.length;
    summarySheet.getRow(totalRowNum).height = 25;
    summarySheet.getRow(totalRowNum).values = [
      'TOTAL GENERAL',
      acumulado.cantidad,
      acumulado.ventas,
      acumulado.original,
      acumulado.neto,
      acumulado.iva,
      acumulado.total,
      acumulado.descuento,
      acumulado.aTransferir,
    ];

    for (let col = 1; col <= 9; col++) {
      const cell = summarySheet.getCell(totalRowNum, col);
      cell.font = { name: 'Segoe UI', size: 11, bold: true, color: { argb: 'FF0F172A' } };
      cell.border = doubleBottomBorder;
      cell.fill = col === 9 ? FILL_TRANSFERIR : { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };

      if (col === 1) {
        cell.alignment = { vertical: 'middle', horizontal: 'left' };
      } else if (col === 2) {
        cell.alignment = { vertical: 'middle', horizontal: 'right' };
        cell.numFormat = '#,##0';
      } else {
        cell.alignment = { vertical: 'middle', horizontal: 'right' };
        cell.numFormat = '$#,##0.00';
      }
    }

    // Linea final, bien visible: la plata que hay que pagar en total este periodo.
    const filaPagar = totalRowNum + 2;
    summarySheet.getRow(filaPagar).height = 32;
    summarySheet.mergeCells(`A${filaPagar}:H${filaPagar}`);
    const celdaEtiqueta = summarySheet.getCell(`A${filaPagar}`);
    celdaEtiqueta.value = 'TOTAL A PAGAR (todas las marcas)';
    celdaEtiqueta.font = { name: 'Segoe UI', size: 12, bold: true, color: { argb: 'FF0F172A' } };
    celdaEtiqueta.alignment = { vertical: 'middle', horizontal: 'right' };
    celdaEtiqueta.fill = FILL_TRANSFERIR;
    const celdaPagar = summarySheet.getCell(`I${filaPagar}`);
    celdaPagar.value = acumulado.aTransferir;
    celdaPagar.font = { name: 'Segoe UI', size: 12, bold: true, color: { argb: 'FF0F172A' } };
    celdaPagar.alignment = { vertical: 'middle', horizontal: 'right' };
    celdaPagar.numFormat = '$#,##0.00';
    celdaPagar.fill = FILL_TRANSFERIR;
    celdaPagar.border = doubleBottomBorder;

    summarySheet.getColumn(1).width = 30;
    summarySheet.getColumn(2).width = 18;
    summarySheet.getColumn(3).width = 22;
    summarySheet.getColumn(4).width = 32;
    summarySheet.getColumn(5).width = 32;
    summarySheet.getColumn(6).width = 18;
    summarySheet.getColumn(7).width = 20;
    summarySheet.getColumn(8).width = 24;
    summarySheet.getColumn(9).width = 24;

    // HOJAS POR MARCA
    // Excel no permite dos hojas con el mismo nombre (y NO distingue mayus/minus).
    // Este helper garantiza nombres unicos: si "Liq - Gotcha" ya existe, usa "Liq - Gotcha (2)", etc.
    const usedSheetNames = new Set();
    const makeSheetName = (prefix, name) => {
      let base = `${prefix}${name}`.replace(/[*?:/[\]\\]/g, '').substring(0, 31);
      let candidate = base;
      let n = 2;
      while (usedSheetNames.has(candidate.toLowerCase())) {
        const suffix = ` (${n})`;
        candidate = base.substring(0, 31 - suffix.length) + suffix;
        n++;
      }
      usedSheetNames.add(candidate.toLowerCase());
      return candidate;
    };

    Object.keys(details).forEach((brandName) => {
      const vendorData = details[brandName];
      const tabName = makeSheetName('Liq - ', brandName);
      const detailSheet = workbook.addWorksheet(tabName);
      detailSheet.views = [{ showGridLines: true }];

      detailSheet.mergeCells('A1:N1');
      const brandTitleCell = detailSheet.getCell('A1');
      brandTitleCell.value = `DETALLE DE LIQUIDACIÓN: ${brandName.toUpperCase()}`;
      brandTitleCell.font = { name: 'Segoe UI', size: 14, bold: true, color: { argb: 'FF0F172A' } };
      brandTitleCell.alignment = { vertical: 'middle', horizontal: 'left' };
      detailSheet.getRow(1).height = 35;

      detailSheet.mergeCells('A2:N2');
      const brandPeriodCell = detailSheet.getCell('A2');
      brandPeriodCell.value = `Periodo consultado (Actualizaciones): ${period || 'N/A'}`;
      brandPeriodCell.font = { name: 'Segoe UI', size: 9, italic: true, color: { argb: 'FF475569' } };
      detailSheet.getRow(2).height = 18;

      detailSheet.getRow(3).height = 10;

      const detailHeaders = [
        'Nombre del pedido',
        'SKU de variante de producto',
        'Título del producto',
        'Título de variante de producto',
        'Estado de pago del pedido',
        'Canal de ventas del pedido',
        'Día',
        'Ventas netas',
        'Devoluciones',
        'Costo de los bienes vendidos (Original)',
        'Costo de los bienes vendidos (Neto)',
        'Cantidad pedida',
        'Ubicación',
      ];

      detailSheet.getRow(4).values = detailHeaders;
      detailSheet.getRow(4).height = 25;

      for (let col = 1; col <= 13; col++) {
        const cell = detailSheet.getCell(4, col);
        cell.fill = headerFill;
        cell.font = headerFont;
        cell.alignment = { vertical: 'middle', horizontal: (col <= 7 || col === 13) ? 'left' : 'right' };
        cell.border = borderStyle;
      }

      let detailStartRow = 5;
      vendorData.items.forEach((item, index) => {
        const currentRowNum = detailStartRow + index;
        
        const dateObj = new Date(item.date);
        // Se muestra la fecha en hora de Argentina (-3), no en UTC: un despacho del 31/8 a las
        // 22:52 es 01:52 UTC del 1/9, y mostrarlo como 01/09 en una liquidación de agosto confunde.
        const formattedDate = isNaN(dateObj.getTime())
          ? item.date
          : new Date(dateObj.getTime() - 3 * 60 * 60 * 1000).toISOString().split('T')[0]; // YYYY-MM-DD

        const refundVal = item.quantity < 0 ? item.totalSale : 0;
        const grossProfit = item.totalSale - item.totalCost;

        detailSheet.getRow(currentRowNum).values = [
          item.orderName,
          item.sku,
          item.title,
          item.variantTitle,
          item.paymentStatus || 'paid',
          item.salesChannel || 'Online Store',
          formattedDate,
          item.totalSale,
          refundVal,
          item.totalCostOriginal,
          item.totalCost,
          item.quantity,
          item.location || 'Sin Ubicación',
        ];
        detailSheet.getRow(currentRowNum).height = 20;

        for (let col = 1; col <= 13; col++) {
          const cell = detailSheet.getCell(currentRowNum, col);
          cell.font = { name: 'Segoe UI', size: 9.5 };
          cell.border = borderStyle;

          if (col <= 7 || col === 13) {
            cell.alignment = { vertical: 'middle', horizontal: 'left' };
          } else if (col === 12) {
            cell.alignment = { vertical: 'middle', horizontal: 'right' };
            cell.numFormat = '#,##0';
          } else {
            cell.alignment = { vertical: 'middle', horizontal: 'right' };
            cell.numFormat = '$#,##0.00';
          }

          if (currentRowNum % 2 === 0) {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
          }
        }

        if (item.quantity < 0) {
          for (let col = 1; col <= 13; col++) {
            const cell = detailSheet.getCell(currentRowNum, col);
            cell.font = { name: 'Segoe UI', size: 9.5, color: { argb: 'FFEF4444' } };
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDF2F2' } };
          }
        }
      });

      const brandTotalRowNum = detailStartRow + vendorData.items.length;
      detailSheet.getRow(brandTotalRowNum).height = 25;
      detailSheet.getRow(brandTotalRowNum).values = [
        'TOTALES',
        '',
        '',
        '',
        '',
        '',
        '',
        { formula: `SUM(H${detailStartRow}:H${brandTotalRowNum-1})` },
        { formula: `SUM(I${detailStartRow}:I${brandTotalRowNum-1})` },
        { formula: `SUM(J${detailStartRow}:J${brandTotalRowNum-1})` },
        { formula: `SUM(K${detailStartRow}:K${brandTotalRowNum-1})` },
        { formula: `SUM(L${detailStartRow}:L${brandTotalRowNum-1})` },
        '',
      ];

      for (let col = 1; col <= 13; col++) {
        const cell = detailSheet.getCell(brandTotalRowNum, col);
        cell.font = { name: 'Segoe UI', size: 10.5, bold: true };
        cell.border = doubleBottomBorder;
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };

        if (col <= 7 || col === 13) {
          cell.alignment = { vertical: 'middle', horizontal: 'left' };
        } else if (col === 12) {
          cell.alignment = { vertical: 'middle', horizontal: 'right' };
          cell.numFormat = '#,##0';
        } else {
          cell.alignment = { vertical: 'middle', horizontal: 'right' };
          cell.numFormat = '$#,##0.00';
        }
      }

      detailSheet.getColumn(1).width = 18;  // Nombre del pedido
      detailSheet.getColumn(2).width = 18;  // SKU
      detailSheet.getColumn(3).width = 35;  // Título del producto
      detailSheet.getColumn(4).width = 15;  // Variante
      detailSheet.getColumn(5).width = 18;  // Estado de pago
      detailSheet.getColumn(6).width = 20;  // Canal de ventas
      detailSheet.getColumn(7).width = 15;  // Día
      detailSheet.getColumn(8).width = 16;  // Ventas netas
      detailSheet.getColumn(9).width = 16;  // Devoluciones
      detailSheet.getColumn(10).width = 26; // Costo Original
      detailSheet.getColumn(11).width = 26; // Costo Neto
      detailSheet.getColumn(12).width = 18; // Beneficio bruto
      detailSheet.getColumn(13).width = 15; // Cantidad pedida
      detailSheet.getColumn(14).width = 24; // Ubicación

      // ==========================================
      // HOJA DE AGRUPADOS (Agr - BRAND)
      // ==========================================
      const agrTabName = makeSheetName('Agr - ', brandName);
      const agrSheet = workbook.addWorksheet(agrTabName);
      agrSheet.views = [{ showGridLines: false }];

      const agrHeaderFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF124265' } };
      const agrHeaderFont = { name: 'Segoe UI', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };

      const salesItems = vendorData.items.filter(item => item.quantity > 0);
      const returnItems = vendorData.items.filter(item => item.quantity < 0);

      const groupedSales = {};
      salesItems.forEach(item => {
        const key = `${item.title} ${item.variantTitle || ''} ${item.unitCostOriginal}`;
        if (!groupedSales[key]) {
          const baseSku = item.sku ? item.sku.split(/[-.]/)[0] : '';
          const variantText = item.variantTitle && item.variantTitle !== 'Default Title' ? ` ${item.variantTitle}` : '';
          groupedSales[key] = { sku: baseSku, desc: `${item.title}${variantText}`, qty: 0, origCost: item.unitCostOriginal, discountPercent: item.discountPercent, netCost: 0 };
        }
        groupedSales[key].qty += item.quantity;
        groupedSales[key].netCost += item.totalCost;
      });

      const groupedReturns = {};
      returnItems.forEach(item => {
        const key = `${item.title} ${item.variantTitle || ''} ${item.unitCostOriginal}`;
        if (!groupedReturns[key]) {
          const baseSku = item.sku ? item.sku.split(/[-.]/)[0] : '';
          const variantText = item.variantTitle && item.variantTitle !== 'Default Title' ? ` ${item.variantTitle}` : '';
          groupedReturns[key] = { sku: baseSku, desc: `${item.title}${variantText}`, qty: 0, origCost: item.unitCostOriginal, discountPercent: item.discountPercent, netCost: 0 };
        }
        groupedReturns[key].qty += item.quantity;
        groupedReturns[key].netCost += item.totalCost;
      });

      const agrHeaders = ['ARTÍCULO', '', 'CANTIDAD', 'PRECIO', '% DES.', 'MTO. DES.', 'MONTO'];
      let r = 1;
      
      const salesArr = Object.values(groupedSales).sort((a,b) => a.desc.localeCompare(b.desc));
      if (salesArr.length > 0) {
        agrSheet.getRow(r).values = agrHeaders;
        agrSheet.getRow(r).height = 20;
        for (let i = 1; i <= 7; i++) {
          const c = agrSheet.getCell(r, i);
          c.fill = agrHeaderFill;
          c.font = agrHeaderFont;
          c.alignment = { horizontal: i <= 2 ? 'left' : 'right' };
          c.border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } };
        }
        r++;
        
        let sumSalesQty = 0;
        let sumSalesNet = 0;
        
        salesArr.forEach(item => {
          const unitDiscount = item.discountPercent > 0 ? (item.origCost * (item.discountPercent / 100)) : 0;
          agrSheet.getRow(r).values = [
            item.sku, 
            item.desc, 
            item.qty, 
            item.origCost, 
            item.discountPercent > 0 ? item.discountPercent : '', 
            item.discountPercent > 0 ? unitDiscount : '', 
            item.netCost
          ];
          for(let i=1; i<=7; i++) {
            const c = agrSheet.getCell(r, i);
            if (i === 3) c.numFormat = '#,##0';
            if ([4, 6, 7].includes(i)) c.numFormat = '#,##0.00';
            if (r % 2 === 0) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD6EAF8' } };
            c.border = { top: { style: 'thin', color: { argb: 'FFDDDDDD' } }, bottom: { style: 'thin', color: { argb: 'FFDDDDDD' } }, left: { style: 'thin', color: { argb: 'FFDDDDDD' } }, right: { style: 'thin', color: { argb: 'FFDDDDDD' } } };
            c.alignment = { horizontal: i <= 2 ? 'left' : 'right' };
          }
          sumSalesQty += item.qty;
          sumSalesNet += item.netCost;
          r++;
        });
        
        agrSheet.getRow(r).values = ['', 'Total general', sumSalesQty, '', '', '', sumSalesNet];
        agrSheet.getRow(r).font = { bold: true };
        agrSheet.getCell(r, 3).numFormat = '#,##0';
        agrSheet.getCell(r, 7).numFormat = '#,##0.00';
        r += 2;
      }

      const returnsArr = Object.values(groupedReturns).sort((a,b) => a.desc.localeCompare(b.desc));
      let sumReturnsNet = 0;

      if (returnsArr.length > 0) {
        agrSheet.getRow(r).values = ['NOTA DE CREDITO POR DEVOLUCIONES'];
        agrSheet.getRow(r).font = { bold: true, size: 12 };
        r += 2;
        
        agrSheet.getRow(r).values = agrHeaders;
        agrSheet.getRow(r).height = 20;
        for (let i = 1; i <= 7; i++) {
          const c = agrSheet.getCell(r, i);
          c.fill = agrHeaderFill;
          c.font = agrHeaderFont;
          c.alignment = { horizontal: i <= 2 ? 'left' : 'right' };
          c.border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } };
        }
        r++;
        
        let sumRetQty = 0;
        
        returnsArr.forEach(item => {
          const unitDiscount = item.discountPercent > 0 ? (item.origCost * (item.discountPercent / 100)) : 0;
          agrSheet.getRow(r).values = [item.sku, item.desc, item.qty, item.origCost, item.discountPercent > 0 ? item.discountPercent : '', item.discountPercent > 0 ? unitDiscount : '', item.netCost];
          for(let i=1; i<=7; i++) {
            const c = agrSheet.getCell(r, i);
            if (i === 3) c.numFormat = '#,##0';
            if ([4, 6, 7].includes(i)) c.numFormat = '#,##0.00';
            if (r % 2 === 0) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD6EAF8' } };
            c.border = { top: { style: 'thin', color: { argb: 'FFDDDDDD' } }, bottom: { style: 'thin', color: { argb: 'FFDDDDDD' } }, left: { style: 'thin', color: { argb: 'FFDDDDDD' } }, right: { style: 'thin', color: { argb: 'FFDDDDDD' } } };
            c.alignment = { horizontal: i <= 2 ? 'left' : 'right' };
          }
          sumRetQty += item.qty;
          sumReturnsNet += item.netCost;
          r++;
        });
        
        agrSheet.getRow(r).values = ['', 'Total general', sumRetQty, '', '', '', sumReturnsNet];
        agrSheet.getRow(r).font = { bold: true };
        agrSheet.getCell(r, 3).numFormat = '#,##0';
        agrSheet.getCell(r, 7).numFormat = '#,##0.00';
        r += 3;
      }
      
      let salesNetTotal = Object.values(groupedSales).reduce((acc, i) => acc + i.netCost, 0);
      let subtotal = salesNetTotal + sumReturnsNet;
      let iva = subtotal * 0.21;
      let total = subtotal + iva;
      
      const isBrandAndCo = brandName.toUpperCase().includes('BRAND & CO') || brandName.toUpperCase().includes('BRAND&CO');
      let descuento = isBrandAndCo ? 0 : (total * -0.03);
      let aTransferir = total + descuento;

      agrSheet.getRow(r).values = ['', '', '', '', '', 'SUBTOTAL', subtotal];
      agrSheet.getRow(r).font = { bold: true };
      agrSheet.getCell(r, 7).numFormat = '#,##0.00';
      r++;
      
      agrSheet.getRow(r).values = ['', '', '', '', '', 'IVA', iva];
      agrSheet.getRow(r).font = { bold: true };
      agrSheet.getCell(r, 7).numFormat = '#,##0.00';
      r++;

      agrSheet.getRow(r).values = ['', '', '', '', '', 'TOTAL', total];
      agrSheet.getRow(r).font = { bold: true };
      agrSheet.getCell(r, 7).numFormat = '#,##0.00';
      r += 2;

      if (!isBrandAndCo) {
        agrSheet.getRow(r).values = ['', '', '', '', '', 'DTO.3% PAGO POR TRANSF.', descuento];
        agrSheet.getRow(r).font = { bold: true };
        agrSheet.getCell(r, 6).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF5EEAD4' } };
        agrSheet.getCell(r, 7).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF5EEAD4' } };
        agrSheet.getCell(r, 7).numFormat = '#,##0.00';
        r += 2;
      }

      agrSheet.getRow(r).values = ['', '', '', '', '', 'TOTAL A TRANSFERIR', aTransferir];
      agrSheet.getRow(r).font = { bold: true };
      agrSheet.getCell(r, 6).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDE047' } };
      agrSheet.getCell(r, 7).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDE047' } };
      agrSheet.getCell(r, 7).numFormat = '#,##0.00';

      agrSheet.getColumn(1).width = 15;
      agrSheet.getColumn(2).width = 50;
      agrSheet.getColumn(3).width = 12;
      agrSheet.getColumn(4).width = 15;
      agrSheet.getColumn(5).width = 10;
      agrSheet.getColumn(6).width = 15;
      agrSheet.getColumn(7).width = 18;
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="Liquidacion_Marketplace.xlsx"');

    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error('Error al generar Excel:', error.message);
    res.status(500).json({
      success: false,
      error: `Error al generar Excel: ${error.message}`,
    });
  }
});

// Ruta comodín para SPA React
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Servidor de liquidaciones corriendo en http://localhost:${PORT}`);
});
