import "next-auth";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      name: string;
      email: string;
      role: string;
      companyId: string;
      companyName: string;
      companySlug: string;
    };
  }
}
