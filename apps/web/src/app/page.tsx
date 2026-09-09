import { redirect } from 'next/navigation';

export default function Home() {
  // Redirect to /app - middleware handles auth, so if we get here, user is logged in
  redirect('/app');
}
