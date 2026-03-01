export function createHealthHandler(config, router) {
  return (req, res) => {
    
    // Gather circuit breaker metrics dynamically from router's adapters
    const providerStats = {};
    if (router && router.adapters) {
       for (const [name, adapter] of router.adapters.entries()) {
           if (adapter.circuitBreaker) {
               providerStats[name] = adapter.circuitBreaker.getStats();
           } else {
               providerStats[name] = { state: 'UNKNOWN' };
           }
       }
    }

    res.json({ 
      status: 'ok',
      providers: providerStats 
    });
  };
}
