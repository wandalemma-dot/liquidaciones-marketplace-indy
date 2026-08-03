import React, { useState, useEffect, useMemo } from 'react';
import axios from 'axios';
import './App.css';

// Descuentos comerciales FIJOS por proveedor (valores por defecto).
// Se aplican solos en cualquier dispositivo. Un cambio manual en la UI los pisa.
// Claves en minuscula para que funcionen sin importar mayus/minus ni espacios extra.
const DEFAULT_DISCOUNTS = {
  'orng': 15,
  'orng mochilas': 12.5,
  'airwalk': 15,
  'amerika sb': 15,
  'mormaii': 15,
  'vision street wear': 15,
  'gotcha': 20,
};

// Normaliza un nombre de marca para buscar su descuento por defecto.
const defaultDiscountFor = (brandName) => {
  if (!brandName) return undefined;
  return DEFAULT_DISCOUNTS[brandName.toString().trim().toLowerCase()];
};

function App() {
  // Credenciales de la App (Dev Dashboard / OAuth)
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [appConfigured, setAppConfigured] = useState(false);
  const [isSavingConfig, setIsSavingConfig] = useState(false);

  // Credenciales de la Tienda Conectada
  const [storeUrl, setStoreUrl] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [isConnecting, setIsConnecting] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [shopName, setShopName] = useState('');
  const [currency, setCurrency] = useState('ARS');

  // Filtros de Rango de Fechas (Pedidos actualizados)
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [financialStatus, setFinancialStatus] = useState('any');
  const [fulfillmentStatus, setFulfillmentStatus] = useState('any');

  // Descuentos por Proveedor (guardados en localStorage)
  const [supplierDiscounts, setSupplierDiscounts] = useState({});

  // Datos y Estados de Carga
  const [isLoading, setIsLoading] = useState(false);
  const [rawSettlementData, setRawSettlementData] = useState(null);
  const [missingCosts, setMissingCosts] = useState([]);
  const [editedCosts, setEditedCosts] = useState({});
  const [selectedBrandDetails, setSelectedBrandDetails] = useState(null);
  const [selectedVendorFilter, setSelectedVendorFilter] = useState('all');
  const [selectedLocationFilter, setSelectedLocationFilter] = useState('all');
  const [locations, setLocations] = useState([]);

  // Modales y Mensajes
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [successMessage, setSuccessMessage] = useState('');

  // 1. CAPTURAR PARAMETROS OAUTH Y CARGAR CONFIGURACIONES AL MONTAR
  useEffect(() => {
    // Verificar si venimos redirigidos de la autenticación de Shopify (OAuth)
    const queryParams = new URLSearchParams(window.location.search);
    const shopParam = queryParams.get('shop');
    const tokenParam = queryParams.get('token');

    if (shopParam && tokenParam) {
      // Guardar credenciales obtenidas
      localStorage.setItem('shopify_store_url', shopParam);
      localStorage.setItem('shopify_access_token', tokenParam);
      
      setStoreUrl(shopParam);
      setAccessToken(tokenParam);

      // Limpiar parámetros de la barra de direcciones del navegador
      window.history.replaceState({}, document.title, window.location.pathname);
      
      // Conectar automáticamente con el nuevo token
      verifyConnection(shopParam, tokenParam, true);
    } else {
      // Si no hay parámetros, cargar credenciales guardadas anteriormente
      const savedUrl = localStorage.getItem('shopify_store_url') || '';
      const savedToken = localStorage.getItem('shopify_access_token') || '';
      
      if (savedUrl && savedToken) {
        setStoreUrl(savedUrl);
        setAccessToken(savedToken);
        verifyConnection(savedUrl, savedToken, false);
      }
    }

    // Consultar al backend si la App ya tiene configuradas sus credenciales locales
    fetchAppConfig();

    // Cargar ubicaciones guardadas
    try {
      const savedLocations = localStorage.getItem('shopify_locations');
      if (savedLocations) {
        setLocations(JSON.parse(savedLocations));
      }
    } catch (e) {
      console.error('Error al cargar ubicaciones de localStorage', e);
    }

    // Cargar descuentos por proveedor guardados en localStorage
    try {
      const savedSupplierDiscounts = localStorage.getItem('shopify_supplier_discounts');
      if (savedSupplierDiscounts) {
        setSupplierDiscounts(JSON.parse(savedSupplierDiscounts));
      } else {
        const savedBrandDiscounts = localStorage.getItem('shopify_brand_discounts');
        if (savedBrandDiscounts) {
          setSupplierDiscounts(JSON.parse(savedBrandDiscounts));
        }
      }
    } catch (e) {
      console.error('Error al cargar descuentos de localStorage', e);
    }

    // Inicializar fechas (primer día del mes actual al día de hoy)
    const today = new Date();
    const firstDay = new Date(today.getFullYear(), today.getMonth(), 1);
    
    const formatDate = (date) => {
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    };

    setStartDate(formatDate(firstDay));
    setEndDate(formatDate(today));
  }, []);

  // Consultar al backend si la App ya tiene configuradas sus credenciales locales
  const fetchAppConfig = async () => {
    try {
      const response = await axios.get('/api/get-app-config');
      if (response.data.clientId) {
        setClientId(response.data.clientId);
        setAppConfigured(true);
      }
    } catch (e) {
      console.error('Error al obtener la configuración de la app desde el backend', e);
    }
  };

  // Guardar credenciales de la App (Client ID/Secret) en el Backend
  const handleSaveAppConfig = async (e) => {
    e.preventDefault();
    if (!clientId || !clientSecret) {
      setErrorMessage('Por favor completa el ID de cliente y el Secreto de cliente.');
      return;
    }

    setIsSavingConfig(true);
    setErrorMessage('');
    
    try {
      const response = await axios.post('/api/save-app-config', {
        clientId,
        clientSecret
      });

      if (response.data.success) {
        setAppConfigured(true);
        setSuccessMessage('¡Configuración de la App guardada con éxito en el servidor!');
        setTimeout(() => setSuccessMessage(''), 4000);
      }
    } catch (error) {
      setErrorMessage(error.response?.data?.error || 'Error al guardar la configuración de la app.');
    } finally {
      setIsSavingConfig(false);
    }
  };

  // Iniciar la instalación/conexión OAuth con Shopify
  const handleStartOAuth = (e) => {
    e.preventDefault();
    if (!storeUrl) {
      setErrorMessage('Por favor ingresa la URL de tu tienda Shopify.');
      return;
    }
    
    // Redirigir al endpoint de autenticación del backend
    window.location.href = `/api/auth?shop=${encodeURIComponent(storeUrl)}`;
  };

  // Verificar conexión activa
  const verifyConnection = async (url = storeUrl, token = accessToken, showNotification = true) => {
    setIsConnecting(true);
    setErrorMessage('');
    
    try {
      const response = await axios.post('/api/verify-connection', {
        storeUrl: url,
        accessToken: token
      });

      if (response.data.success) {
        setIsConnected(true);
        setShopName(response.data.shopName);
        setCurrency(response.data.currency);

        const locs = response.data.locations || [];
        setLocations(locs);
        localStorage.setItem('shopify_locations', JSON.stringify(locs));

        if (showNotification) {
          setSuccessMessage(`¡Conectado exitosamente a la tienda: ${response.data.shopName}!`);
          setTimeout(() => setSuccessMessage(''), 4000);
        }
      }
    } catch (error) {
      setIsConnected(false);
      setErrorMessage(error.response?.data?.error || 'No se pudo conectar a Shopify. Vuelve a iniciar la instalación.');
    } finally {
      setIsConnecting(false);
    }
  };

  const handleDisconnect = () => {
    localStorage.removeItem('shopify_store_url');
    localStorage.removeItem('shopify_access_token');
    localStorage.removeItem('shopify_locations');
    setIsConnected(false);
    setShopName('');
    setRawSettlementData(null);
    setMissingCosts([]);
    setEditedCosts({});
    setStoreUrl('');
    setAccessToken('');
    setLocations([]);
  };

  // Buscar pedidos (updated_at) y procesar liquidaciones
  const fetchSettlements = async () => {
    if (!isConnected) {
      setErrorMessage('Debes estar conectado a Shopify para realizar esta acción.');
      return;
    }

    setIsLoading(true);
    setErrorMessage('');
    setRawSettlementData(null);
    setMissingCosts([]);
    setEditedCosts({});
    setSelectedBrandDetails(null);
    setSelectedVendorFilter('all');

    try {
      const response = await axios.post('/api/fetch-settlements', {
        storeUrl,
        accessToken,
        startDate,
        endDate,
        financialStatus,
        fulfillmentStatus,
        brandDiscounts: {} // Se envía vacío porque el frontend calcula descuentos reactivamente
      });

      if (response.data.success) {
        setRawSettlementData(response.data);
        setMissingCosts(response.data.missingCosts || []);
        
        if (response.data.ordersCount === 0) {
          setErrorMessage('No se encontraron pedidos actualizados en el rango de fechas seleccionado.');
        } else if (response.data.missingCosts?.length > 0) {
          setSuccessMessage(`Se procesaron los pedidos. Atención: Hay productos sin costos en Shopify.`);
        } else {
          setSuccessMessage(`Liquidación calculada con éxito.`);
          setTimeout(() => setSuccessMessage(''), 4000);
        }
      }
    } catch (error) {
      setErrorMessage(error.response?.data?.error || 'Error al procesar las liquidaciones.');
    } finally {
      setIsLoading(false);
    }
  };

  // 1.45. OBTENER TODAS LAS UBICACIONES UNICAS EN EL PERIODO
  const uniqueLocations = useMemo(() => {
    if (!rawSettlementData || !rawSettlementData.details) return [];
    const locations = new Set();
    Object.values(rawSettlementData.details).forEach((brandData) => {
      brandData.items.forEach((item) => {
        if (item.location) {
          locations.add(item.location);
        }
      });
    });
    return Array.from(locations).sort();
  }, [rawSettlementData]);

  // Combinar ubicaciones pre-cargadas de la API y las que aparecen en las transacciones calculadas
  const availableLocations = useMemo(() => {
    const set = new Set(locations);
    uniqueLocations.forEach(loc => set.add(loc));
    return Array.from(set).sort();
  }, [locations, uniqueLocations]);

  // 1.5. CALCULAR LIQUIDACION AGRUPADA Y FILTRADA REACTIVAMENTE
  const groupedData = useMemo(() => {
    if (!rawSettlementData || !rawSettlementData.details) return null;

    const supplierAggregates = {};

    Object.keys(rawSettlementData.details).forEach((rawBrand) => {
      const brandData = rawSettlementData.details[rawBrand];
      const manualDiscount = supplierDiscounts[rawBrand];
      const discountPercent = (manualDiscount !== undefined && manualDiscount !== '')
        ? parseFloat(manualDiscount)
        : (defaultDiscountFor(rawBrand) || 0);

      brandData.items.forEach((item) => {
        // Filtrar por ubicación si está seleccionada
        if (selectedLocationFilter !== 'all' && item.location !== selectedLocationFilter) {
          return;
        }

        // Lazy initialization para omitir proveedores sin transacciones en la ubicación filtrada
        if (!supplierAggregates[rawBrand]) {
          supplierAggregates[rawBrand] = {
            brandName: rawBrand,
            totalQuantity: 0,
            totalSales: 0,
            totalCost: 0,
            totalCostOriginal: 0,
            items: [],
          };
        }

        const supplierData = supplierAggregates[rawBrand];
        const sku = item.sku || 'SIN_SKU';
        // Verificar si hay costo editado temporalmente
        const isEdited = editedCosts[sku] !== undefined;
        const unitCost = isEdited ? editedCosts[sku] : item.unitCost;
        const hasCostInShopify = item.hasCostInShopify || isEdited;

        // Costo de lista (sin descuento) = costo neto inflado por el % del proveedor.
        // Se aplica a TODOS los articulos de la marca, no solo a los editados a mano.
        let unitCostOriginal = item.unitCostOriginal || unitCost;
        if (discountPercent > 0 && discountPercent < 100) {
          unitCostOriginal = unitCost / (1 - (discountPercent / 100));
        }

        const quantity = item.quantity;
        const totalSale = item.totalSale; // Ya viene del backend calculado bien
        const totalCost = unitCost * quantity;
        const totalCostOriginal = unitCostOriginal * quantity;

        supplierData.totalQuantity += quantity;
        supplierData.totalSales += totalSale;
        supplierData.totalCost += totalCost;
        supplierData.totalCostOriginal += totalCostOriginal;

        supplierData.items.push({
          ...item,
          unitCost,
          totalCost,
          unitCostOriginal,
          totalCostOriginal,
          discountPercent,
          hasCostInShopify,
        });
      });
    });

    // Limpiar proveedores que quedaron con actividad neta cero (ej: una venta y una devolución que se anulan)
    Object.keys(supplierAggregates).forEach((key) => {
      const v = supplierAggregates[key];
      if (v.totalQuantity === 0 && Math.abs(v.totalSales) < 0.01 && Math.abs(v.totalCost) < 0.01) {
        delete supplierAggregates[key];
      }
    });

    const summary = Object.values(supplierAggregates).map((v) => {
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

    summary.sort((a, b) => a.brandName.localeCompare(b.brandName));

    return {
      summary,
      details: supplierAggregates,
    };
  }, [rawSettlementData, supplierDiscounts, editedCosts, selectedLocationFilter]);

  // 1.55. CONTAR PEDIDOS ACTIVOS EN EL FILTRO ACTUAL (POR SUCURSAL Y PROVEEDOR)
  const filteredOrdersCount = useMemo(() => {
    if (!groupedData || !groupedData.details) return 0;
    const orderNames = new Set();
    Object.values(groupedData.details).forEach((supplierData) => {
      supplierData.items.forEach((item) => {
        if (item.orderName) {
          orderNames.add(item.orderName);
        }
      });
    });
    return orderNames.size;
  }, [groupedData]);

  // 1.6. DETECTAR TRANSACCIONES INUSUALES PARA REVISION MANUAL
  const transactionAlerts = useMemo(() => {
    if (!groupedData || !groupedData.details) return [];
    
    const alerts = [];
    
    Object.keys(groupedData.details).forEach((supplierName) => {
      const supplierData = groupedData.details[supplierName];
      supplierData.items.forEach((item) => {
        // 1. Alerta: Producto vendido sin costo asignado en Shopify ni en la app
        if (item.quantity !== 0 && !item.hasCostInShopify && item.unitCost === 0) {
          alerts.push({
            orderName: item.orderName,
            sku: item.sku,
            title: item.title,
            supplier: supplierName,
            message: `El producto se vendió sin costo asignado ($0). Se liquidará a costo $0.`,
          });
        }
        
        // 2. Alerta: Costo neto es mayor al precio de venta (margen negativo) para ventas
        if (item.quantity > 0 && item.unitCost > item.salePrice) {
          alerts.push({
            orderName: item.orderName,
            sku: item.sku,
            title: item.title,
            supplier: supplierName,
            message: `El costo neto ($${item.unitCost.toFixed(2)}) es mayor al precio de venta ($${item.salePrice.toFixed(2)}), generando pérdidas en la venta.`,
          });
        }

        // 3. Alerta: Inconsistencias de signos
        if (item.quantity > 0 && item.totalSale < 0) {
          alerts.push({
            orderName: item.orderName,
            sku: item.sku,
            title: item.title,
            supplier: supplierName,
            message: `La cantidad es positiva (${item.quantity}) pero el monto neto es negativo ($${item.totalSale.toFixed(2)}).`,
          });
        }
      });
    });
    
    return alerts;
  }, [groupedData]);

  // Actualizar descuento de un proveedor reactivamente
  const handleUpdateDiscount = (supplierName, discountVal) => {
    const discount = parseFloat(discountVal) || 0;
    const updatedDiscounts = { ...supplierDiscounts, [supplierName]: discount };
    
    setSupplierDiscounts(updatedDiscounts);
    localStorage.setItem('shopify_supplier_discounts', JSON.stringify(updatedDiscounts));
  };

  // Asignar costo temporal a un SKU
  const handleUpdateCost = (sku, newCost) => {
    const cost = parseFloat(newCost) || 0;
    const updatedCosts = { ...editedCosts, [sku]: cost };
    setEditedCosts(updatedCosts);
  };

  // Exportar Excel
  const handleExportExcel = async () => {
    if (!groupedData) return;

    try {
      setSuccessMessage('Generando reporte Excel...');
      
      const filteredSummary = selectedVendorFilter === 'all'
        ? groupedData.summary
        : groupedData.summary.filter(s => s.brandName === selectedVendorFilter);

      const filteredDetails = selectedVendorFilter === 'all'
        ? groupedData.details
        : { [selectedVendorFilter]: groupedData.details[selectedVendorFilter] };

      const response = await axios.post('/api/export-excel', {
        summary: filteredSummary,
        details: filteredDetails,
        period: `${startDate} al ${endDate}`
      }, {
        responseType: 'blob'
      });

      const blob = new Blob([response.data], { 
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' 
      });
      
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      
      let filename = 'Liquidacion';
      if (selectedVendorFilter !== 'all') {
        filename += `_${selectedVendorFilter.replace(/[*?:/[\]\\]/g, '').replace(/\s+/g, '_')}`;
      }
      if (selectedLocationFilter !== 'all') {
        filename += `_${selectedLocationFilter.replace(/[*?:/[\]\\]/g, '').replace(/\s+/g, '_')}`;
      }
      filename += `_${startDate}_a_${endDate}.xlsx`;

      link.setAttribute('download', filename);
      document.body.appendChild(link);
      link.click();
      
      link.parentNode.removeChild(link);
      window.URL.revokeObjectURL(url);
      
      setSuccessMessage('¡Excel de liquidación descargado exitosamente!');
      setTimeout(() => setSuccessMessage(''), 5000);
    } catch (error) {
      console.error(error);
      setErrorMessage('Error al descargar el Excel.');
    }
  };

  const formatCurrency = (amount) => {
    const isNegative = amount < 0;
    const absVal = Math.abs(amount);
    const formatted = new Intl.NumberFormat('es-AR', {
      style: 'currency',
      currency: currency,
      minimumFractionDigits: 2
    }).format(absVal);
    
    return isNegative ? `-$${formatted.replace(/^[^-0-9]+/g, '')}` : formatted;
  };

  const formatDateString = (dateStr) => {
    const d = new Date(dateStr);
    return isNaN(d.getTime()) ? dateStr : d.toLocaleDateString('es-AR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric'
    });
  };

  const getTotals = () => {
    if (!groupedData || !groupedData.summary) {
      return { sales: 0, cost: 0, costOriginal: 0, margin: 0, items: 0 };
    }
    
    const targetSummary = selectedVendorFilter === 'all'
      ? groupedData.summary
      : groupedData.summary.filter(s => s.brandName === selectedVendorFilter);
      
    return targetSummary.reduce((acc, current) => {
      acc.sales += current.totalSales;
      acc.cost += current.totalCost;
      acc.costOriginal += current.totalCostOriginal;
      acc.margin += current.margin;
      acc.items += current.totalQuantity;
      return acc;
    }, { sales: 0, cost: 0, costOriginal: 0, margin: 0, items: 0 });
  };

    const totals = getTotals();

  return (
    <div className="app-container">
      {/* HEADER */}
      <header className="app-header">
        <div className="logo-section">
          <h1>
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#3B82F6" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: '10px' }}>
              <line x1="12" y1="2" x2="12" y2="22" />
              <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
            </svg>
            Marketplace Liquidaciones v2
          </h1>
          <p>Gestión de liquidaciones con descuentos comerciales y notas de crédito de devoluciones y cancelaciones</p>
        </div>
        {isConnected && (
          <div className="shop-badge">
            Tienda: {shopName} ({currency})
          </div>
        )}
      </header>

      {/* ALERTAS */}
      {errorMessage && (
        <div className="alert alert-error">
          <span><strong>Error:</strong> {errorMessage}</span>
          <button className="close-btn" onClick={() => setErrorMessage('')}>&times;</button>
        </div>
      )}
      {successMessage && (
        <div className="alert alert-success">
          <span>{successMessage}</span>
          <button className="close-btn" onClick={() => setSuccessMessage('')}>&times;</button>
        </div>
      )}

      {/* 1. SECCION DE CONEXION (OAUTH NUEVO REQUERIMIENTO 2026) */}
      {!isConnected ? (
        <div style={{display: 'flex', flexDirection: 'column', gap: '2rem'}}>
          
          {/* PASO 1: CONFIGURAR DEV DASHBOARD CREDENTIALS */}
          <div className="card">
            <h2 style={{marginBottom: '1rem', fontSize: '1.4rem'}}>Paso 1: Configurar Credenciales de la App (Dev Dashboard)</h2>
            <p style={{color: 'var(--text-muted)', fontSize: '0.85rem', marginBottom: '1.5rem', lineHeight: '1.5'}}>
              Debido a las políticas de Shopify 2026, debes registrar tu aplicación local en tu <strong>Dev Dashboard</strong> (Partner Dashboard). 
              Copia y pega los siguientes datos en la configuración de tu App en Shopify:
            </p>
            <div style={{background: 'rgba(255,255,255,0.02)', padding: '1rem', borderRadius: '8px', border: '1px solid var(--border-color)', marginBottom: '1.5rem', display: 'flex', flexDirection: 'column', gap: '0.5rem', fontSize: '0.85rem'}}>
              <div><strong>App URL (URL de la app):</strong> <code style={{color: '#60a5fa'}}>http://localhost:3001</code></div>
              <div><strong>Allowed Redirect URL (URL de redireccionamiento):</strong> <code style={{color: '#60a5fa'}}>http://localhost:3001/api/auth/callback</code></div>
            </div>

            <form onSubmit={handleSaveAppConfig}>
              <div className="config-grid">
                <div className="form-group">
                  <label htmlFor="clientId">ID de Cliente (Client ID)</label>
                  <input
                    type="text"
                    id="clientId"
                    className="form-control"
                    placeholder="Obtenido en Shopify Partners"
                    value={clientId}
                    onChange={(e) => setClientId(e.target.value)}
                  />
                </div>
                <div className="form-group">
                  <label htmlFor="clientSecret">Secreto del Cliente (Client Secret)</label>
                  <input
                    type="password"
                    id="clientSecret"
                    className="form-control"
                    placeholder={appConfigured ? "•••••••••••••••••••• (Guardado)" : "Obtenido en Shopify Partners"}
                    value={clientSecret}
                    onChange={(e) => setClientSecret(e.target.value)}
                  />
                </div>
              </div>
              <div className="form-actions">
                <button type="submit" className="btn btn-secondary" disabled={isSavingConfig}>
                  {isSavingConfig ? 'Guardando...' : 'Guardar Credenciales de App'}
                </button>
              </div>
            </form>
          </div>

          {/* PASO 2: INSTALAR APP EN TIENDA */}
          <div className="card" style={{opacity: appConfigured ? 1 : 0.5, pointerEvents: appConfigured ? 'auto' : 'none'}}>
            <h2 style={{marginBottom: '1rem', fontSize: '1.4rem'}}>Paso 2: Conectar e Instalar en tu Tienda</h2>
            <p style={{color: 'var(--text-muted)', fontSize: '0.85rem', marginBottom: '1.5rem'}}>
              Ingresa el dominio de tu tienda de Shopify para iniciar la autenticación automática de OAuth.
            </p>
            <form onSubmit={handleStartOAuth}>
              <div className="form-group" style={{maxWidth: '500px', marginBottom: '1.5rem'}}>
                <label htmlFor="storeUrl">URL de la tienda (.myshopify.com)</label>
                <input
                  type="text"
                  id="storeUrl"
                  className="form-control"
                  placeholder="ejemplo.myshopify.com"
                  value={storeUrl}
                  onChange={(e) => setStoreUrl(e.target.value)}
                  disabled={!appConfigured}
                />
              </div>
              <div className="form-actions" style={{justifyContent: 'flex-start'}}>
                <button type="submit" className="btn btn-primary" disabled={!appConfigured || isConnecting}>
                  {isConnecting ? (
                    <>
                      <span className="spinner" style={{width: '16px', height: '16px', borderWidth: '2px'}}></span>
                      Instalando...
                    </>
                  ) : 'Conectar y Autorizar en Shopify'}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : (
        /* PANEL DE FILTROS */
        <div className="card">
          <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem'}}>
            <h2 style={{fontSize: '1.3rem'}}>Rango de Fechas (Pedidos Actualizados/Devoluciones)</h2>
            <button className="btn btn-secondary" style={{padding: '0.4rem 0.8rem', fontSize: '0.8rem'}} onClick={handleDisconnect}>
              Desconectar Tienda
            </button>
          </div>
          
          <div className="config-grid" style={{gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))'}}>
            <div className="form-group">
              <label htmlFor="startDate">Fecha Inicio</label>
              <input
                type="date"
                id="startDate"
                className="form-control"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
            </div>
            <div className="form-group">
              <label htmlFor="endDate">Fecha Fin</label>
              <input
                type="date"
                id="endDate"
                className="form-control"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </div>
            <div className="form-group">
              <label htmlFor="vendorFilterMain">Proveedor / Marca</label>
              <select
                id="vendorFilterMain"
                className="form-control"
                value={selectedVendorFilter}
                onChange={(e) => {
                  setSelectedVendorFilter(e.target.value);
                  setSelectedBrandDetails(null);
                }}
              >
                <option value="all">Ver Todos los Proveedores</option>
                {groupedData && groupedData.summary.map(s => (
                  <option key={s.brandName} value={s.brandName}>{s.brandName}</option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label htmlFor="locationFilterMain">Ubicación / Sucursal</label>
              <select
                id="locationFilterMain"
                className="form-control"
                value={selectedLocationFilter}
                onChange={(e) => setSelectedLocationFilter(e.target.value)}
              >
                <option value="all">Todas las Ubicaciones</option>
                {availableLocations.map(loc => (
                  <option key={loc} value={loc}>{loc}</option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label htmlFor="financialStatus">Estado Financiero</label>
              <select
                id="financialStatus"
                className="form-control"
                value={financialStatus}
                onChange={(e) => setFinancialStatus(e.target.value)}
              >
                <option value="any">Todos los estados (Recomendado)</option>
                <option value="paid">Pagados (Paid)</option>
                <option value="partially_refunded">Reembolsado Parcial</option>
                <option value="refunded">Reembolsado Total</option>
              </select>
            </div>
            <div className="form-group">
              <label htmlFor="fulfillmentStatus">Estado de Envío</label>
              <select
                id="fulfillmentStatus"
                className="form-control"
                value={fulfillmentStatus}
                onChange={(e) => setFulfillmentStatus(e.target.value)}
              >
                <option value="any">Todos los Estados</option>
                <option value="fulfilled">Enviados (Fulfilled)</option>
                <option value="unfulfilled">No Enviados (Unfulfilled)</option>
              </select>
            </div>
          </div>

          <div className="form-actions" style={{marginTop: '1.5rem'}}>
            <button 
              className="btn btn-primary" 
              onClick={fetchSettlements} 
              disabled={isLoading}
            >
              {isLoading ? (
                <>
                  <span className="spinner" style={{width: '16px', height: '16px', borderWidth: '2px'}}></span>
                  Procesando Transacciones...
                </>
              ) : 'Calcular Liquidación'}
            </button>
          </div>
        </div>
      )}

      {/* 2. PANTALLA DE CARGA */}
      {isLoading && (
        <div className="card loading-wrapper">
          <span className="spinner"></span>
          <div style={{textAlign: 'center'}}>
            <h3 style={{marginBottom: '0.5rem'}}>Sincronizando con Shopify API...</h3>
            <p style={{color: 'var(--text-muted)', fontSize: '0.85rem'}}>
              Buscando pedidos actualizados, devoluciones cerradas y cancelaciones en el rango...
            </p>
          </div>
          <div className="loading-bar-container">
            <div className="loading-bar"></div>
          </div>
        </div>
      )}

      {/* 3. ALERTA DE COSTOS FALTANTES */}
      {rawSettlementData && missingCosts.length > 0 && (
        <div className="alert alert-warning" style={{flexDirection: 'row', alignItems: 'center'}}>
          <div>
            <strong style={{color: '#d97706'}}>Costos Faltantes Detectados:</strong> 
            {` Hay ${missingCosts.length} producto(s) vendidos sin costo cargado en Shopify. Hemos asignado $0 de costo neto. Puedes asignarle un costo temporal haciendo clic a la derecha.`}
          </div>
          <button 
            className="btn btn-secondary" 
            style={{borderColor: 'rgba(217, 119, 6, 0.3)', background: 'rgba(217, 119, 6, 0.1)', color: '#fbbf24', whiteSpace: 'nowrap'}}
            onClick={() => setIsModalOpen(true)}
          >
            Corregir Costos
          </button>
        </div>
      )}

      {/* 4. CONFIGURAR DESCUENTOS COMERCIALES POR PROVEEDOR */}
      {groupedData && groupedData.summary && groupedData.summary.length > 0 && (
        <div className="card">
          <h2 style={{fontSize: '1.2rem', marginBottom: '1rem'}}>1. Configurar Descuentos Comerciales por Proveedor</h2>
          <p style={{color: 'var(--text-muted)', fontSize: '0.85rem', marginBottom: '1.5rem', lineHeight: '1.4'}}>
            Ingresa el descuento comercial acordado con cada proveedor. Shopify ya tiene el costo neto aplicado (el que le pagas). 
            Usaremos este descuento para calcular a la inversa el **Costo Original (Sin Descuento)** para mostrar en tu reporte de Excel.
          </p>
          <div style={{display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '1rem'}}>
            {groupedData.summary.map((row) => (
              <div key={`discount-${row.brandName}`} style={{background: 'rgba(255,255,255,0.02)', padding: '0.75rem 1rem', borderRadius: '8px', border: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', alignItems: 'center'}}>
                <span style={{fontSize: '0.85rem', fontWeight: '500', maxWidth: '120px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'}} title={row.brandName}>
                  {row.brandName}
                </span>
                <div style={{display: 'flex', alignItems: 'center', gap: '0.5rem', width: '80px'}}>
                  <input
                    type="number"
                    min="0"
                    max="99"
                    className="form-control"
                    style={{padding: '0.3rem 0.5rem', fontSize: '0.85rem', textAlign: 'right'}}
                    placeholder="0"
                    value={supplierDiscounts[row.brandName] ?? (defaultDiscountFor(row.brandName) ?? '')}
                    onChange={(e) => handleUpdateDiscount(row.brandName, e.target.value)}
                  />
                  <span style={{fontSize: '0.85rem', color: 'var(--text-muted)'}}>%</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 5. DASHBOARD */}
      {groupedData && groupedData.summary && (
        <>
          {/* ALERTAS DE CONSISTENCIA / REVISION MANUAL */}
          {transactionAlerts.length > 0 && (
            <div className="card" style={{borderColor: 'rgba(239, 68, 68, 0.4)', background: 'rgba(239, 68, 68, 0.03)', marginBottom: '1.5rem', animation: 'fadeIn 0.3s ease-out'}}>
              <h3 style={{color: '#f87171', display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '1.05rem', marginBottom: '0.75rem', marginTop: 0}}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{color: '#f87171'}}>
                  <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
                  <line x1="12" y1="9" x2="12" y2="13"></line>
                  <line x1="12" y1="17" x2="12.01" y2="17"></line>
                </svg>
                Alertas de Consistencia (Revisión Manual Sugerida)
              </h3>
              <p style={{color: 'var(--text-muted)', fontSize: '0.82rem', marginBottom: '1rem', lineHeight: '1.4'}}>
                Se han detectado {transactionAlerts.length} transacciones inusuales en este periodo. Te recomendamos revisarlas para garantizar la exactitud de tu liquidación:
              </p>
              <div style={{maxHeight: '160px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '0.4rem', paddingRight: '0.5rem'}}>
                {transactionAlerts.map((alert, idx) => (
                  <div key={idx} style={{background: 'rgba(255, 255, 255, 0.01)', padding: '0.5rem 0.85rem', borderRadius: '6px', border: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.8rem', gap: '1rem'}}>
                    <div>
                      <strong style={{color: 'var(--color-indigo)'}}>{alert.orderName}</strong> - <span style={{fontFamily: 'monospace'}}>{alert.sku}</span>: {alert.message}
                    </div>
                    <span style={{fontSize: '0.75rem', color: 'var(--text-muted)', whiteSpace: 'nowrap'}}>
                      Proveedor: {alert.supplier}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}



          <div className="stats-grid">
            <div className="stat-card">
              <span className="stat-label">Pedidos Con Actividad</span>
              <span className="stat-value currency" style={{color: 'var(--color-indigo)'}}>{filteredOrdersCount}</span>
              <span className="stat-sub">De un total de {rawSettlementData.ordersCount} pedidos en el rango</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Ventas Netas (PVP)</span>
              <span className="stat-value currency">{formatCurrency(totals.sales)}</span>
              <span className="stat-sub">PVP de artículos netos enviados</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Costo Total Original (Sin Desc.)</span>
              <span className="stat-value currency" style={{color: 'var(--color-amber)'}}>{formatCurrency(totals.costOriginal)}</span>
              <span className="stat-sub">Costo de lista del proveedor</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">A Liquidar (Costo Shopify)</span>
              <span className="stat-value payout">{formatCurrency(totals.cost)}</span>
              <span className="stat-sub">Monto neto a pagar (con desc.)</span>
            </div>
          </div>

          {/* Tabla de Resumen */}
          <div className="card">
            <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem', flexWrap: 'wrap', gap: '1rem'}}>
              <div>
                <h2 style={{fontSize: '1.3rem'}}>2. Resumen de Liquidación por Proveedor</h2>
                <p style={{color: 'var(--text-muted)', fontSize: '0.85rem', marginTop: '0.2rem'}}>
                  Haz clic en cualquier fila para inspeccionar las ventas y Notas de Crédito
                </p>
              </div>
              <button className="btn btn-emerald" onClick={handleExportExcel}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                  <polyline points="7 10 12 15 17 10"></polyline>
                  <line x1="12" y1="15" x2="12" y2="3"></line>
                </svg>
                {selectedVendorFilter === 'all' ? 'Descargar Liquidación en Excel' : `Descargar Liquidación de ${selectedVendorFilter}`}
              </button>
            </div>

            <div className="table-container">
              <table className="custom-table">
                <thead>
                  <tr>
                    <th>Proveedor</th>
                    <th className="text-right">Cantidad pedida</th>
                    <th className="text-right">Ventas netas</th>
                    <th className="text-right">Costo de los bienes vendidos (Original)</th>
                    <th className="text-right">Costo de los bienes vendidos (Neto)</th>
                  </tr>
                </thead>
                <tbody>
                  {(selectedVendorFilter === 'all'
                    ? groupedData.summary
                    : groupedData.summary.filter(s => s.brandName === selectedVendorFilter)
                  ).map((row) => (
                    <tr key={row.brandName} onClick={() => setSelectedBrandDetails(groupedData.details[row.brandName])} style={{cursor: 'pointer'}}>
                      <td><strong>{row.brandName}</strong></td>
                      <td className="text-right" style={{color: row.totalQuantity < 0 ? 'var(--color-rose)' : 'inherit'}}>
                        {row.totalQuantity}
                      </td>
                      <td className="text-right">{formatCurrency(row.totalSales)}</td>
                      <td className="text-right" style={{color: 'var(--color-amber)'}}>{formatCurrency(row.totalCostOriginal)}</td>
                      <td className="text-right" style={{color: '#60a5fa', fontWeight: '500'}}>{formatCurrency(row.totalCost)}</td>
                    </tr>
                  ))}
                  <tr style={{background: 'rgba(255, 255, 255, 0.03)', borderTop: '2px solid var(--border-color)', fontWeight: 'bold'}}>
                    <td>TOTAL GENERAL</td>
                    <td className="text-right">{totals.items}</td>
                    <td className="text-right">{formatCurrency(totals.sales)}</td>
                    <td className="text-right" style={{color: 'var(--color-amber)'}}>{formatCurrency(totals.costOriginal)}</td>
                    <td className="text-right" style={{color: '#60a5fa'}}>{formatCurrency(totals.cost)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* 6. DETALLE POR PROVEEDOR SELECCIONADO */}
      {selectedBrandDetails && (
        <div className="card" style={{animation: 'slideIn 0.3s ease-out'}}>
          <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem'}}>
            <div>
              <h2 style={{fontSize: '1.3rem'}}>Detalle de Operaciones: {selectedBrandDetails.brandName}</h2>
              <p style={{color: 'var(--text-muted)', fontSize: '0.85rem'}}>
                Ventas (+) y Notas de Crédito por Devolución/Cancelación (-) registradas en el periodo
              </p>
            </div>
            <button className="btn btn-secondary" style={{padding: '0.4rem 0.8rem', fontSize: '0.8rem'}} onClick={() => setSelectedBrandDetails(null)}>
              Cerrar Detalle
            </button>
          </div>

          <div className="table-container">
            <table className="custom-table" style={{fontSize: '0.82rem'}}>
              <thead>
                <tr>
                  <th>ID del pedido</th>
                  <th>Fecha</th>
                  <th>Tipo</th>
                  <th>Estado Pago</th>
                  <th>SKU</th>
                  <th>Título del producto</th>
                  <th className="text-right">Cantidad pedida</th>
                  <th className="text-right">PVP Unit</th>
                  <th className="text-right">Ventas netas</th>
                  <th className="text-right">Costo Unit. Sin Desc.</th>
                  <th className="text-right">Costo Unit. Neto</th>
                  <th className="text-right">Costo de los bienes vendidos</th>
                  <th>Ubicación</th>
                </tr>
              </thead>
              <tbody>
                {selectedBrandDetails.items.map((item, idx) => {
                  const isNegative = item.quantity < 0;
                  return (
                    <tr 
                      key={`${item.orderName}-${item.sku}-${idx}`} 
                      style={isNegative ? { background: 'rgba(244, 63, 94, 0.05)' } : {}}
                    >
                      <td style={{color: isNegative ? 'var(--color-rose)' : 'inherit'}}>
                        <strong>{item.orderName}</strong>
                      </td>
                      <td>{formatDateString(item.date)}</td>
                      <td>
                        <span className={`badge ${isNegative ? 'badge-rose' : 'badge-emerald'}`}>
                          {item.type}
                        </span>
                      </td>
                      <td>
                        <span className="badge badge-secondary" style={{textTransform: 'uppercase', fontSize: '0.7rem', opacity: 0.85}}>
                          {item.paymentStatus || 'paid'}
                        </span>
                      </td>
                      <td style={{fontFamily: 'monospace', color: 'var(--color-indigo)'}}>{item.sku}</td>
                      <td>
                        <div style={{fontWeight: isNegative ? '500' : 'normal'}}>{item.title}</div>
                        {item.variantTitle && <span style={{fontSize: '0.75rem', color: 'var(--text-muted)'}}>{item.variantTitle}</span>}
                      </td>
                      <td className="text-right" style={{fontWeight: 'bold', color: isNegative ? 'var(--color-rose)' : 'inherit'}}>
                        {item.quantity}
                      </td>
                      <td className="text-right">{formatCurrency(item.salePrice)}</td>
                      <td className="text-right" style={{color: isNegative ? 'var(--color-rose)' : 'inherit'}}>
                        {formatCurrency(item.totalSale)}
                      </td>
                      <td className="text-right" style={{color: 'var(--color-amber)'}}>
                        {formatCurrency(item.unitCostOriginal)}
                      </td>
                      <td className="text-right" style={{color: !item.hasCostInShopify ? 'var(--color-amber)' : 'inherit'}}>
                        {formatCurrency(item.unitCost)}
                        {!item.hasCostInShopify && <span style={{fontSize: '0.65rem', display: 'block', color: 'var(--color-amber)'}}>Sin Costo</span>}
                      </td>
                      <td className="text-right" style={{fontWeight: '500', color: isNegative ? 'var(--color-rose)' : '#60a5fa'}}>
                        {formatCurrency(item.totalCost)}
                      </td>
                      <td>{item.location || 'Sin Ubicación'}</td>
                    </tr>
                  );
                })}
                <tr style={{background: 'rgba(255, 255, 255, 0.03)', borderTop: '2px solid var(--border-color)', fontWeight: 'bold'}}>
                  <td colSpan="6">TOTALES CONCILIADOS</td>
                  <td className="text-right">{selectedBrandDetails.totalQuantity}</td>
                  <td></td>
                  <td className="text-right">{formatCurrency(selectedBrandDetails.totalSales)}</td>
                  <td></td>
                  <td></td>
                  <td className="text-right" style={{color: '#60a5fa'}}>{formatCurrency(selectedBrandDetails.totalCost)}</td>
                  <td></td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 7. MODAL PARA CORREGIR COSTOS FALTANTES */}
      {isModalOpen && (
        <div className="modal-overlay">
          <div className="modal-content">
            <div className="modal-header">
              <h2>Corregir Costos Unitarios Faltantes</h2>
              <button className="close-btn" onClick={() => setIsModalOpen(false)}>&times;</button>
            </div>
            
            <div className="modal-body">
              <p style={{color: 'var(--text-muted)', fontSize: '0.85rem', marginBottom: '1.5rem', lineHeight: '1.5'}}>
                Los siguientes productos se vendieron en el periodo pero no tienen un costo configurado en Shopify. 
                Ingresa los costos correspondientes a continuación. Al hacerlo, <strong>se recalculará la liquidación de forma inmediata</strong> en pantalla y en la exportación de Excel.
              </p>

              <div style={{borderBottom: '1px solid var(--border-color)', paddingBottom: '0.5rem', marginBottom: '0.5rem', fontWeight: '600', fontSize: '0.85rem', display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: '1rem', color: 'var(--text-muted)'}}>
                <span>Producto / SKU</span>
                <span style={{textAlign: 'right'}}>Precio Venta</span>
                <span style={{textAlign: 'right'}}>Costo Unitario ($)</span>
              </div>

              <div style={{display: 'flex', flexDirection: 'column', gap: '0.5rem'}}>
                {missingCosts.map((item) => (
                  <div key={item.sku} className="missing-cost-item">
                    <div className="item-info">
                      <span className="item-sku">{item.sku}</span>
                      <span className="item-title" title={item.title}>{item.title}</span>
                      <span className="item-brand">Marca: {item.vendor}</span>
                    </div>
                    <div className="item-price">
                      {formatCurrency(item.shopifyPrice)}
                    </div>
                    <div className="cost-input-wrapper">
                      <span className="cost-input-symbol">$</span>
                      <input
                        type="number"
                        className="form-control cost-input"
                        placeholder="0.00"
                        value={editedCosts[item.sku] !== undefined ? editedCosts[item.sku] : ''}
                        onChange={(e) => handleUpdateCost(item.sku, e.target.value)}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="modal-footer">
              <button className="btn btn-primary" onClick={() => setIsModalOpen(false)}>
                Listo (Recalcular)
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
