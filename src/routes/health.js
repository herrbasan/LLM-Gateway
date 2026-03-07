export function createHealthHandler(config, router) {
  return (req, res) => {
    // Gather circuit breaker metrics from adapters
    const adapterStats = {};
    if (router && router.adapters) {
       for (const [name, adapter] of router.adapters.entries()) {
           if (adapter.circuitBreaker) {
               adapterStats[name] = adapter.circuitBreaker.getStats();
           } else {
               adapterStats[name] = { state: 'UNKNOWN' };
           }
       }
    }

    res.json({ 
      status: 'ok',
      version: '2.0.0',
      adapters: adapterStats,
      models: router.registry ? router.registry.getModelIds() : []
    });
  };
}
