export const WEATHER_UPDATED_EVENT = 'foxos:weather-updated';

export const weatherTemperatureFromPayload = (payload) => {
  const temperature = payload?.current?.temperature;
  return payload?.configured === true && Number.isFinite(temperature)
    ? Math.round(temperature)
    : null;
};

export const publishWeatherUpdate = (payload) => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(WEATHER_UPDATED_EVENT, {
    detail: { temperature: weatherTemperatureFromPayload(payload) }
  }));
};
