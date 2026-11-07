/* Optional map provider. null uses OSM's online tiles and browser HTTP cache.
   OSM tiles are never prefetched or included in an offline package.
   Set offlineAllowed only when the provider explicitly permits offline storage.
   An authorised internal tile set may use './offline-maps/{z}/{x}/{y}.png'.
   Only public, domain-restricted API keys belong here; never use server secrets.
   Example (disabled):
   { name: '허가된 기관 지도', urlTemplate: 'https://maps.example/{z}/{x}/{y}.png?key={key}',
     attribution: '© 지도 제공기관', maxZoom: 19, requiresKey: true, apiKey: '05098281-437F-478D-B584-059393B1904F',
     offlineAllowed: true, cacheDays: 7 }
*/
globalThis.DONGGU_MAP_PROVIDER = null;

// Optional online VWorld imagery. Set only a public, domain-restricted map key.
// The ordinary map remains available while this key is empty. Image tiles are
// never added to the app's offline tile archive, regardless of this flag.
globalThis.DONGGU_SATELLITE_CONFIG = {
  apiKey: '05098281-437F-478D-B584-059393B1904F',
  maxNativeZoom: 18,
  offlineAllowed: false
};
