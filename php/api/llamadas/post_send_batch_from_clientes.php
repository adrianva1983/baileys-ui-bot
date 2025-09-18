<?php
header("Content-Type: application/json; charset=utf-8");

// 1) URL de tu API que devuelve clientes
$clientesApiUrl = "http://host.docker.internal:8080/api/pendientes.php"; 
// ⚠️ cambia la URL a la real de tu API

// 2) Llamar a la API de clientes
$ch = curl_init($clientesApiUrl);
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT        => 30,
]);
$clientesResponse = curl_exec($ch);
$err = curl_error($ch);
curl_close($ch);

if ($err) {
    echo json_encode(["ok"=>false,"error"=>"Error API clientes: $err"], JSON_UNESCAPED_UNICODE);
    exit;
}

// 3) Decodificar JSON de la API
$clientes = json_decode($clientesResponse, true);
if (!is_array($clientes)) {
    echo json_encode(["ok"=>false,"error"=>"La API de clientes no devolvió un array válido"], JSON_UNESCAPED_UNICODE);
    exit;
}

// 4) Funciones auxiliares
function normaliza_movil($raw, $defaultCC = "34") {
    $digits = preg_replace('/\D+/', '', (string)$raw);
    if ($digits === "") return null;
    if (strpos($digits, "00") === 0) $digits = substr($digits, 2);
    if (strlen($digits) <= 11 && strpos($digits, $defaultCC) !== 0) {
        $digits = $defaultCC . ltrim($digits, "0");
    }
    if (strlen($digits) < 10 || strlen($digits) > 15) return null;
    return $digits;
}
function plantilla_msg($nombre, $url) {
    return "Hola {$nombre}, soy del equipo de Hipotea Asesores 👋\n".
           "Te comparto tu enlace para continuar el proceso cuando te venga bien:\n{$url}\n\n".
           "Si tienes alguna duda, responde a este WhatsApp y te ayudamos.";
}

// 5) Construir items
$items = [];
foreach ($clientes as $c) {
    $to = normaliza_movil($c["movil"] ?? "");
    if (!$to) continue;
    $text = plantilla_msg($c["nombre"] ?? "", $c["url"] ?? "");
    $items[] = ["to"=>$to, "text"=>$text];
}
if (!$items) {
    echo json_encode(["ok"=>false,"error"=>"No se generaron items válidos"], JSON_UNESCAPED_UNICODE);
    exit;
}

// 6) Enviar a Node /send-batch
$endpointNode = "http://host.docker.internal:3000/send-batch";
$payload = json_encode(["items"=>$items], JSON_UNESCAPED_UNICODE);

$ch = curl_init($endpointNode);
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_POST           => true,
    CURLOPT_HTTPHEADER     => ["Content-Type: application/json"],
    CURLOPT_POSTFIELDS     => $payload,
    CURLOPT_TIMEOUT        => 60,
]);
$response = curl_exec($ch);
$err = curl_error($ch);
$http = curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

// 7) Responder
if ($err) {
    echo json_encode(["ok"=>false, "error"=>$err], JSON_UNESCAPED_UNICODE);
} else {
    echo $response ?: json_encode(["ok"=>false,"http"=>$http,"error"=>"sin_respuesta"], JSON_UNESCAPED_UNICODE);
}
