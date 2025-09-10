<?php
declare(strict_types=1);
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

$from      = $_POST['from']      ?? '';
$text      = trim((string)($_POST['text'] ?? ''));
$isGroup   = filter_var($_POST['isGroup'] ?? 'false', FILTER_VALIDATE_BOOLEAN);
$groupName = $_POST['groupName'] ?? '';
$jid       = $_POST['jid']       ?? '';
$pushName  = $_POST['pushName']  ?? '';
$ts        = (int)($_POST['ts'] ?? 0);

if ($text === '') {
  echo json_encode(['ok' => true, 'text' => '(sin texto)'], JSON_UNESCAPED_UNICODE);
  exit;
}

/* Ejemplo de routing muy básico */
if (preg_match('~^/ping\b~i', $text)) {
  $reply = 'Pong!';
} elseif (preg_match('~^/help\b~i', $text)) {
  $reply = "Comandos: /ping, /help";
} else {
  $reply = $isGroup
    ? "($groupName) $pushName: $text"
    : "Soy un bot y has dicho: $text";
}

echo json_encode(['ok' => true, 'text' => $reply], JSON_UNESCAPED_UNICODE);
exit;
