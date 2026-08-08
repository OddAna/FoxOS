export const AUTH_REQUIRED_EVENT = 'foxos:authentication-required';

export const apiFetch = async (resource, options) => {
  const response = await fetch(resource, options);
  if (response.ok) {
    return response;
  }

  let message = 'FoxOS API request failed';
  try {
    const payload = await response.clone().json();
    if (payload.error) {
      message = payload.error;
    }
  } catch {
    // Keep the generic message when the response is not JSON.
  }

  if (
    response.status === 401 && message === 'Authentication required' &&
    typeof window !== 'undefined'
  ) {
    window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
  }

  const error = new Error(message);
  error.status = response.status;
  throw error;
};
