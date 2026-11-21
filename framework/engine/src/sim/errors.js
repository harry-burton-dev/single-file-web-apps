// Plain Error objects whose `.name` matches the File System Access API names
// the engine has to cope with (spec section 2.2).

export function fsError(name, message) {
  const error = new Error(message ?? name);
  error.name = name;
  return error;
}

export const notFound = (what) => fsError("NotFoundError", `${what} not found`);
export const typeMismatch = (what) => fsError("TypeMismatchError", `${what} is not the requested kind`);
export const invalidName = (name) => fsError("TypeError", `invalid entry name: ${JSON.stringify(name)}`);
