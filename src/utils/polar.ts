import { Polar } from '@polar-sh/sdk';

export const createPolarClient = (accessToken: string) => {
    return new Polar({
        accessToken,
        server: "sandbox"
    });
}