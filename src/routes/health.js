export function createHealthHandler() {
  return (req, res) => {
    // In the future this will also check provider health
    res.json({ status: 'ok' });
  };
}
