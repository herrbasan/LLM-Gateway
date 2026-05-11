export function createHealthHandler(config, router) {
  return (req, res) => {
    // Gather circuit breaker metrics from adapters
    const adapterStats = {};
    if (router && router.adapters) {
       for (const [name, adapter] of router.adapters.entries()) {
           if (adapter.circuitBreakers) {
               const breakerStats = {};
               for (const [method, breaker] of Object.entries(adapter.circuitBreakers)) {
                   breakerStats[method] = breaker.getStats();
               }
               adapterStats[name] = breakerStats;
           } else if (adapter.circuitBreaker) {
               // Backwards compatibility for single breaker
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
