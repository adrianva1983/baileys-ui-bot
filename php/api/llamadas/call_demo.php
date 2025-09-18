<?php
// call_demo.php
// Llama al endpoint Node /send-batch-demo

//$endpoint = "http://localhost:3000/send-batch-demo"; // cambia el puerto si tu servicio corre en otro
$endpoint = "http://host.docker.internal:3000/send-batch-demo"; // <? importante

$ch = curl_init($endpoint);
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_CUSTOMREQUEST  => "GET",
    CURLOPT_TIMEOUT        => 60,
]);

$response = curl_exec($ch);
$err      = curl_error($ch);
$http     = curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

header("Content-Type: application/json; charset=utf-8");

if ($err) {
    echo json_encode(["ok" => false, "error" => $err], JSON_UNESCAPED_UNICODE);
    exit;
}

echo $response ?: json_encode([
    "ok"   => false,
    "http" => $http,
    "error"=> "sin_respuesta"
], JSON_UNESCAPED_UNICODE);
