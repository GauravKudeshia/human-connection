import BetaApp from "../beta/beta-app";
import "../beta/beta.css";

export const metadata = {
  title: "Customer sign-in · Human Connection",
  robots: { index: false, follow: false },
};

export default function SignInPage() {
  return <BetaApp workspace="customer" />;
}
