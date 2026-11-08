export function CheckoutHub({ user, total }: { user: string; total: number }) {
  const token = localStorage.getItem("token");
  const onClick = async () => {
    const receipt = await fetch("/billing", { method: "POST", body: JSON.stringify({ user, total, token }) });
    localStorage.setItem("lastReceipt", await receipt.text());
    document.cookie = "checkout=complete";
    window.location.assign("/receipt");
  };
  const formatted = new Intl.NumberFormat("en").format(total);
  return <button onClick={onClick}>Pay {formatted}</button>;
}
