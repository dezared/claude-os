// An error the Claude OS server answers with its status code; a tool answers with the message.
export const httpError = (statusCode: number, message: string): Error & { statusCode: number } => Object.assign(new Error(message), { statusCode });
