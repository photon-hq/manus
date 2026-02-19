/**
 * Generate OpenPanel frontend script tag
 * Returns empty string if OPENPANEL_CLIENT_ID or OPENPANEL_API_URL is not configured
 */
export function getOpenPanelScriptTag(): string {
  const clientId = process.env.OPENPANEL_CLIENT_ID;
  const apiUrl = process.env.OPENPANEL_API_URL;

  if (!clientId || clientId.trim() === '' || !apiUrl || apiUrl.trim() === '') {
    return '';
  }

  return `
    <!-- OpenPanel Analytics -->
    <script>
      window.op=window.op||function(){var n=[];return new Proxy(function(){arguments.length&&n.push([].slice.call(arguments))},{get:function(t,r){return"q"===r?n:function(){n.push([r].concat([].slice.call(arguments)))}} ,has:function(t,r){return"q"===r}}) }();
      window.op('init', {
        clientId: '${clientId}',
        apiUrl: '${apiUrl}',
        trackScreenViews: true,
        trackOutgoingLinks: true,
        trackAttributes: true,
      });
    </script>
    <script src="https://openpanel.dev/op1.js" defer async></script>
    <!-- End OpenPanel Analytics -->
  `;
}
